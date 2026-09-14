/**
 * Collects BetBull/BetBear logs into round_pool_events. Every run follows the confirmed head; backfill lowers the
 * collected range a few chunks per run until the configured depth, or until the log node stops serving older
 * history. Public nodes prune logs after a few days, so continuous forward collection is what builds the dataset.
 */
import { errorMessage } from '../util/json.js';
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';
import type { MarketService } from './markets.js';

/** Consecutive failures of a request before backfill stops or forward collection skips the range as a gap. */
const MAX_FAILURES = 3;
/** Forward chunks per run, so a run stays short after a long outage; later runs continue. */
const MAX_FORWARD_CHUNKS = 20;
/** Final rounds checked for exact pool reconstruction in status() (one day of rounds). */
const CHECK_EPOCHS = 288;

export interface PoolEventRun {
  inserted: number;
  fromBlock: number;
  toBlock: number;
  headBlock: number;
  backfillDone: boolean;
  /** Forward collection reached the confirmed head and backfill has finished. */
  caughtUp: boolean;
}

export class PoolEventCollector {
  private running = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly markets: MarketService,
  ) {}

  /** One collection pass; returns null when a pass is already running. */
  async run(opts: { backfillChunks?: number } = {}): Promise<PoolEventRun | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.collect(opts.backfillChunks ?? 0);
    } finally {
      this.running = false;
    }
  }

  private async collect(backfillChunks: number): Promise<PoolEventRun> {
    const { reader, repos, config, audit } = this.ctx;
    const marketId = this.markets.tradable().id;
    const { chunkBlocks, backfillBlocks } = config.poolEvents;
    const head = Number((await reader.getHead()).blockNumber);
    const safe = head - config.confirmations;
    const sync =
      (await repos.poolEvents.sync(marketId)) ?? (await repos.poolEvents.initSync(marketId, safe + 1));
    let inserted = 0;

    let to = sync.toBlock;
    let forwardStalled = false;
    for (let i = 0; i < MAX_FORWARD_CHUNKS && to < safe; i++) {
      const hi = Math.min(safe, to + chunkBlocks);
      try {
        const events = await reader.getBetEvents(BigInt(to + 1), BigInt(hi));
        inserted += await repos.poolEvents.append(marketId, events, { toBlock: hi });
      } catch (err) {
        const failures = await repos.poolEvents.recordFailure(marketId, 'forward', errorMessage(err));
        if (failures < MAX_FAILURES) {
          forwardStalled = true;
          break;
        }
        await repos.poolEvents.skipGap(marketId, to + 1, hi, errorMessage(err));
        await audit.record({
          component: 'pool-events',
          severity: 'WARN',
          type: AuditType.POOL_EVENTS_GAP,
          message: `bet events for blocks ${to + 1}-${hi} could not be fetched; rounds in this range will fail the completeness check`,
          metadata: { fromBlock: to + 1, toBlock: hi, error: errorMessage(err) },
        });
      }
      to = hi;
    }

    let from = sync.fromBlock;
    let backfillDone = sync.backfillDone;
    const floor = Math.max(0, sync.anchorBlock - backfillBlocks);
    for (let i = 0; i < backfillChunks && !backfillDone && from > floor; i++) {
      const lo = Math.max(floor, from - chunkBlocks);
      try {
        const events = await reader.getBetEvents(BigInt(lo), BigInt(from - 1));
        inserted += await repos.poolEvents.append(marketId, events, { fromBlock: lo });
        from = lo;
      } catch (err) {
        const failures = await repos.poolEvents.recordFailure(marketId, 'backfill', errorMessage(err));
        if (failures >= MAX_FAILURES) {
          await repos.poolEvents.setBackfillDone(marketId, true);
          backfillDone = true;
          await audit.record({
            component: 'pool-events',
            severity: 'INFO',
            type: AuditType.POOL_EVENTS_BACKFILL_STOPPED,
            message: `backfill stopped at block ${from}: the log node no longer serves older history`,
            metadata: { block: from, error: errorMessage(err) },
          });
        }
        break;
      }
    }
    if (!backfillDone && from <= floor) {
      await repos.poolEvents.setBackfillDone(marketId, true);
      backfillDone = true;
    }

    return {
      inserted,
      fromBlock: from,
      toBlock: to,
      headBlock: head,
      backfillDone,
      caughtUp: !forwardStalled && to >= safe && backfillDone,
    };
  }

  async resetBackfill(): Promise<void> {
    await this.ctx.repos.poolEvents.setBackfillDone(this.markets.tradable().id, false);
  }

  /** Collection state plus an exact-reconstruction check of the most recent final rounds. */
  async status() {
    const { repos, config } = this.ctx;
    const marketId = this.markets.tradable().id;
    const sync = await repos.poolEvents.sync(marketId);
    const summary = await repos.poolEvents.summary(marketId);
    const gaps = await repos.poolEvents.gaps(marketId);
    let check = null;
    if (summary.firstEpoch !== null && summary.lastEpoch !== null) {
      // The oldest collected round is normally cut by the backfill boundary, so it is left out.
      const fromEpoch = Math.max(summary.firstEpoch + 1, summary.lastEpoch - CHECK_EPOCHS);
      const rows = await repos.poolEvents.check(marketId, fromEpoch, summary.lastEpoch);
      const incomplete = rows.filter((r) => !r.complete);
      check = {
        fromEpoch,
        toEpoch: summary.lastEpoch,
        finalRounds: rows.length,
        complete: rows.length - incomplete.length,
        incompleteEpochs: incomplete.slice(0, 20).map((r) => r.epoch),
      };
    }
    return { enabled: config.poolEvents.enabled, sync, summary, gaps, check };
  }
}
