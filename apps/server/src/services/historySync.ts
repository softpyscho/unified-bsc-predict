/**
 * Historical ingestion (replaces bsc-predict-updater's update_predict.py).
 *  - initial sync: every epoch from 1 to currentEpoch that is not already final in the DB;
 *  - incremental sync: new epochs plus any stored round that is not yet final;
 *  - reconciliation: re-reads stale/non-final rounds, fills gaps, and sweeps stored final rounds against the chain.
 * Reads are pinned to `head − CONFIRMATIONS` and finality is judged with that block's timestamp, so nothing is
 * marked final because of a transient observation. Upserts are idempotent (UNIQUE(market_id, epoch)).
 */
import { FINAL_STATUSES, deriveOutcome, deriveRoundStatus } from '@bsc/core';
import type { ChainHead } from '../chain/types.js';
import type { StoredRound, UpsertResult } from '../repositories/index.js';
import { chunk, mapPool, range, withRetry } from '../util/async.js';
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';
import type { MarketService } from './markets.js';

export interface SyncSummary {
  requested: number;
  fetched: number;
  inserted: number;
  updated: number;
  finalized: number;
  unchanged: number;
  corrected: number;
  conflicts: number;
  skipped: number;
}

const empty = (): SyncSummary => ({
  requested: 0,
  fetched: 0,
  inserted: 0,
  updated: 0,
  finalized: 0,
  unchanged: 0,
  corrected: 0,
  conflicts: 0,
  skipped: 0,
});

function tally(s: SyncSummary, r: UpsertResult): void {
  if (r === 'inserted') s.inserted++;
  else if (r === 'updated') s.updated++;
  else if (r === 'finalized') s.finalized++;
  else if (r === 'unchanged' || r === 'stale') s.unchanged++;
  else if (r === 'corrected') s.corrected++;
  else if (r === 'conflict') s.conflicts++;
}

/** Epochs verified per reconciliation run in the sweep over stored final rounds. */
const VERIFY_SWEEP = 1_000;
/** Recent window checked for gaps on every reconciliation. */
const GAP_WINDOW = 2_000;
/** Maximum age of the pinned read block (well inside the ~128-block state window of full nodes). */
const PIN_TTL_MS = 20_000;

export class HistorySync {
  constructor(
    private readonly ctx: Ctx,
    private readonly markets: MarketService,
    private readonly onFinalized: (rounds: StoredRound[]) => void,
  ) {}

  async syncEpochs(
    epochs: readonly number[],
    opts: { includeFinal?: boolean; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<SyncSummary> {
    const { reader, repos, config } = this.ctx;
    const market = this.markets.tradable();
    const params = await this.markets.params();
    // Public (non-archive) nodes prune state after ~128 blocks, so a long sync re-pins to a fresh
    // `head − CONFIRMATIONS` block regularly and on every retry.
    let pin: { block: bigint; head: ChainHead; at: number } | null = null;
    const getPin = async () => {
      if (!pin || Date.now() - pin.at > PIN_TTL_MS) {
        const head = await withRetry(() => reader.getHead());
        const block = head.blockNumber - BigInt(config.confirmations);
        pin = { block, head: await withRetry(() => reader.getHead(block)), at: Date.now() };
      }
      return pin;
    };
    const first = await getPin();

    let todo = [...new Set(epochs)]
      .filter((e) => e > 0 && e <= first.head.currentEpoch)
      .sort((a, b) => a - b);
    if (!opts.includeFinal && todo.length > 0) {
      const finals = repos.rounds.finalEpochsIn(market.id, todo[0]!, todo.at(-1)!);
      todo = todo.filter((e) => !finals.has(e));
    }
    const summary = empty();
    summary.requested = todo.length;
    let done = 0;

    await mapPool(chunk(todo, config.syncBatchSize), config.syncConcurrency, async (batch) => {
      let pinned = await getPin();
      const records = await withRetry(
        async () => {
          pinned = await getPin();
          return reader.getRounds(batch, pinned.block);
        },
        {
          onRetry: (err, n) => {
            pin = null;
            this.ctx.log.app.warn(
              { err, attempt: n, from: batch[0] },
              'round batch fetch failed; re-pinning and retrying',
            );
          },
        },
      );
      const pinBlock = pinned.block;
      const chainTime = pinned.head.blockTimestamp;
      const finalized: StoredRound[] = [];
      repos.db.tx(() => {
        for (const rec of records) {
          summary.fetched++;
          if (rec.startTime === null) {
            summary.skipped++;
            continue;
          }
          const status = deriveRoundStatus(rec, chainTime, params.bufferSeconds);
          const outcome = deriveOutcome(rec, status);
          const res = repos.rounds.upsert(market.id, {
            record: rec,
            status,
            outcome,
            isFinal: FINAL_STATUSES.has(status),
            source: 'CHAIN',
            treasuryFeeBps: params.treasuryFeeBps,
            observedBlock: Number(pinBlock),
            observedAt: chainTime,
          });
          tally(summary, res.result);
          if (res.result === 'corrected') {
            this.ctx.audit.record({
              component: 'history-sync',
              severity: 'WARN',
              type: AuditType.ROUND_CORRECTED,
              marketId: market.id,
              epoch: rec.epoch,
              message: `imported data for round ${rec.epoch} differed from chain; corrected (previous values kept)`,
            });
          } else if (res.result === 'conflict') {
            this.ctx.audit.record({
              component: 'history-sync',
              severity: 'ERROR',
              type: AuditType.ROUND_CONFLICT,
              marketId: market.id,
              epoch: rec.epoch,
              message: `final chain data for round ${rec.epoch} changed after finalization; stored data NOT overwritten`,
            });
          }
          if (
            res.round.isFinal &&
            (res.result === 'inserted' || res.result === 'finalized' || res.result === 'corrected')
          ) {
            finalized.push(res.round);
          }
        }
      });
      done += batch.length;
      opts.onProgress?.(done, todo.length);
      if (finalized.length > 0) this.onFinalized(finalized);
    });

    repos.sync.update(market.id, { lastSyncedEpoch: first.head.currentEpoch, synced: true });
    return summary;
  }

  /** Initial synchronization (or catch-up after a long outage). */
  async syncAll(fromEpoch = 1, onProgress?: (done: number, total: number) => void): Promise<SyncSummary> {
    const head = await withRetry(() => this.ctx.reader.getHead());
    const summary = await this.syncEpochs(range(fromEpoch, head.currentEpoch), { onProgress });
    this.auditSync('full', summary);
    return summary;
  }

  /**
   * New rounds since the last final one, plus stored rounds that are still not final. `maxEpochs` bounds the
   * catch-up to the most recent window (startup recovery uses it so trading is not blocked by a long backfill;
   * the background loop runs unbounded).
   */
  async syncIncremental(opts: { maxEpochs?: number } = {}): Promise<SyncSummary> {
    const market = this.markets.tradable();
    const head = await withRetry(() => this.ctx.reader.getHead());
    const lastFinal = this.ctx.repos.rounds.maxEpoch(market.id, true);
    let from = lastFinal === null ? Math.max(1, head.currentEpoch - GAP_WINDOW) : lastFinal + 1;
    if (opts.maxEpochs !== undefined) from = Math.max(from, head.currentEpoch - opts.maxEpochs);
    const pending = this.ctx.repos.rounds.nonFinal(market.id, head.currentEpoch).map((r) => r.epoch);
    const summary = await this.syncEpochs([...range(from, head.currentEpoch), ...pending]);
    if (summary.requested > 3) this.auditSync('incremental', summary);
    return summary;
  }

  /**
   * Repairs the database against the chain: stale non-final rounds, gaps in the recent window, and a rolling
   * verification sweep over stored final rounds (CSV-imported rows are corrected; chain conflicts are reported).
   */
  async reconcile(): Promise<{
    stale: SyncSummary;
    gaps: SyncSummary;
    sweep: SyncSummary;
    sweepRange: [number, number] | null;
  }> {
    const { repos } = this.ctx;
    const market = this.markets.tradable();
    const head = await withRetry(() => this.ctx.reader.getHead());

    const staleEpochs = repos.rounds.nonFinal(market.id, head.currentEpoch - 2).map((r) => r.epoch);
    const stale = await this.syncEpochs(staleEpochs);

    const windowFrom = Math.max(1, head.currentEpoch - GAP_WINDOW);
    const gaps = await this.syncEpochs(range(windowFrom, head.currentEpoch - 1));

    const stats = repos.rounds.stats(market.id);
    let sweep = empty();
    let sweepRange: [number, number] | null = null;
    if (stats.minEpoch !== null && stats.maxEpoch !== null) {
      const state = repos.sync.get(market.id);
      let start = state.reconcileCursor ?? stats.minEpoch;
      if (start > stats.maxEpoch) start = stats.minEpoch;
      const end = Math.min(start + VERIFY_SWEEP - 1, stats.maxEpoch);
      sweep = await this.syncEpochs(range(start, end), { includeFinal: true });
      sweepRange = [start, end];
      repos.sync.update(market.id, { reconcileCursor: end + 1 });
    }
    repos.sync.update(market.id, { reconciled: true });
    this.ctx.audit.record({
      component: 'history-sync',
      severity: stale.conflicts + gaps.conflicts + sweep.conflicts > 0 ? 'ERROR' : 'INFO',
      type: AuditType.RECONCILE_COMPLETED,
      marketId: market.id,
      message: `reconciliation: ${stale.requested} stale, ${gaps.requested} gap epochs, swept ${sweepRange ? `${sweepRange[0]}-${sweepRange[1]}` : 'none'}; ${sweep.corrected} corrected, ${stale.conflicts + gaps.conflicts + sweep.conflicts} conflicts`,
      metadata: { stale, gaps, sweep, sweepRange },
    });
    return { stale, gaps, sweep, sweepRange };
  }

  private auditSync(kind: string, s: SyncSummary): void {
    this.ctx.audit.record({
      component: 'history-sync',
      severity: s.conflicts > 0 ? 'ERROR' : 'INFO',
      type: AuditType.HISTORY_SYNCED,
      marketId: this.markets.tradable().id,
      message: `${kind} sync: ${s.requested} epochs requested, ${s.inserted} inserted, ${s.finalized} finalized, ${s.conflicts} conflicts`,
      metadata: { ...s },
    });
  }
}
