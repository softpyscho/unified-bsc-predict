/**
 * Live round tracking: one pinned snapshot per poll (2 RPC calls) gives currentEpoch, the three active rounds,
 * chain time and the oracle price. Rounds are written to the canonical rounds table — the monitor holds no
 * separate copy of round state beyond the latest snapshot it publishes.
 * A round that looks final at the head is re-read `CONFIRMATIONS` blocks deeper before it is stored as final.
 */
import { FINAL_STATUSES, deriveOutcome, deriveRoundStatus } from '@bsc/core';
import type { RoundRecord } from '@bsc/core';
import type { ChainSnapshot, ContractParams, OraclePrice } from '../chain/types.js';
import type { StoredRound } from '../repositories/index.js';
import { range } from '../util/async.js';
import { errorMessage } from '../util/json.js';
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';
import type { HistorySync } from './historySync.js';
import type { MarketService } from './markets.js';

export interface MarketState {
  marketId: number;
  marketSlug: string;
  currentEpoch: number;
  chainTime: number;
  blockNumber: string;
  paused: boolean;
  observedAtMs: number;
  stale: boolean;
  lastError: string | null;
  oracle: OraclePrice | null;
  params: ContractParams;
  /** Open for bets (currentEpoch). */
  next: StoredRound | null;
  /** Locked and running (currentEpoch − 1). */
  live: StoredRound | null;
  /** Most recently closed (currentEpoch − 2). */
  expired: StoredRound | null;
  /** Starts when `next` locks. */
  later: { epoch: number; startTime: number | null; lockTime: number | null } | null;
}

const FAILURES_BEFORE_ALERT = 3;

export class RoundMonitor {
  private current: MarketState | null = null;
  private lastEpoch: number | null = null;
  private failures = 0;
  private readonly listeners = new Set<(s: MarketState) => void>();

  constructor(
    private readonly ctx: Ctx,
    private readonly markets: MarketService,
    private readonly history: HistorySync,
    private readonly onFinalized: (rounds: StoredRound[]) => Promise<unknown>,
  ) {}

  get state(): MarketState | null {
    if (!this.current) return null;
    const stale = this.ctx.clock.nowMs() - this.current.observedAtMs > this.ctx.config.pollIntervalMs * 4;
    return stale === this.current.stale ? this.current : { ...this.current, stale: true };
  }

  onState(listener: (s: MarketState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Estimated chain time now, extrapolated from the last snapshot. */
  chainNow(state = this.current): number | null {
    if (!state) return null;
    return state.chainTime + Math.max(0, (this.ctx.clock.nowMs() - state.observedAtMs) / 1000);
  }

  async tick(): Promise<MarketState | null> {
    const { reader, audit } = this.ctx;
    let snapshot: ChainSnapshot;
    let params: ContractParams;
    try {
      params = await this.markets.params();
      snapshot = await reader.getSnapshot();
    } catch (err) {
      this.failures++;
      if (this.failures === FAILURES_BEFORE_ALERT) {
        await audit.record({
          component: 'round-monitor',
          severity: 'WARN',
          type: AuditType.RPC_UNAVAILABLE,
          message: `chain reads failing (${this.failures} consecutive): ${errorMessage(err)}`,
        });
      }
      if (this.current) {
        this.current = { ...this.current, stale: true, lastError: errorMessage(err) };
        this.publish(this.current);
      }
      return null;
    }
    if (this.failures >= FAILURES_BEFORE_ALERT) {
      await audit.record({
        component: 'round-monitor',
        severity: 'INFO',
        type: AuditType.RPC_RECOVERED,
        message: 'chain reads recovered',
      });
    }
    this.failures = 0;

    const market = this.markets.tradable();
    const finalized: StoredRound[] = [];
    const byEpoch = new Map<number, StoredRound>();
    const confirmedFinal = await this.confirmFinal(snapshot, params);

    for (const rec of snapshot.rounds) {
      if (rec.startTime === null) continue;
      const confirmed = confirmedFinal.get(rec.epoch);
      const record = confirmed?.record ?? rec;
      let status = deriveRoundStatus(
        record,
        confirmed ? confirmed.chainTime : snapshot.blockTimestamp,
        params.bufferSeconds,
      );
      // Final at the head but not yet at the confirmed depth: keep it non-final for now.
      if (FINAL_STATUSES.has(status) && !confirmed) status = 'CLOSING';
      const isFinal = FINAL_STATUSES.has(status);
      const prev = await this.ctx.repos.rounds.get(market.id, rec.epoch);
      const res = await this.ctx.repos.rounds.upsert(market.id, {
        record,
        status,
        outcome: deriveOutcome(record, status),
        isFinal,
        source: 'CHAIN',
        treasuryFeeBps: params.treasuryFeeBps,
        observedBlock: Number(snapshot.blockNumber),
        observedAt: snapshot.blockTimestamp,
      });
      byEpoch.set(rec.epoch, res.round);
      if (prev && prev.status !== res.round.status) {
        await audit.record({
          component: 'round-monitor',
          severity: 'DEBUG',
          type: AuditType.ROUND_UPDATED,
          marketId: market.id,
          epoch: rec.epoch,
          message: `round ${rec.epoch}: ${prev.status} → ${res.round.status}`,
        });
      }
      if (isFinal && (res.result === 'finalized' || res.result === 'inserted')) {
        finalized.push(res.round);
        await audit.record({
          component: 'round-monitor',
          severity: 'INFO',
          type: AuditType.ROUND_SETTLED,
          marketId: market.id,
          epoch: rec.epoch,
          message: `round ${rec.epoch} final: ${res.round.outcome}`,
          metadata: {
            lockPrice: res.round.lockPrice,
            closePrice: res.round.closePrice,
            totalAmount: res.round.totalAmount.toString(),
          },
        });
      }
    }

    if (this.lastEpoch === null || snapshot.currentEpoch > this.lastEpoch) {
      if (this.lastEpoch !== null) {
        await audit.record({
          component: 'round-monitor',
          severity: 'INFO',
          type: AuditType.ROUND_DETECTED,
          marketId: market.id,
          epoch: snapshot.currentEpoch,
          message: `round ${snapshot.currentEpoch} open for bets`,
        });
        if (snapshot.currentEpoch > this.lastEpoch + 1) {
          // Missed rounds (e.g. process was suspended): backfill through the history pipeline.
          const missed = range(this.lastEpoch + 1, snapshot.currentEpoch - 1);
          this.history
            .syncEpochs(missed)
            .catch((err: unknown) => this.ctx.log.app.error({ err }, 'gap backfill failed'));
        }
      }
      this.lastEpoch = snapshot.currentEpoch;
    }
    if (finalized.length > 0) await this.onFinalized(finalized);

    const next = byEpoch.get(snapshot.currentEpoch) ?? null;
    this.current = {
      marketId: market.id,
      marketSlug: market.slug,
      currentEpoch: snapshot.currentEpoch,
      chainTime: snapshot.blockTimestamp,
      blockNumber: snapshot.blockNumber.toString(),
      paused: snapshot.paused,
      observedAtMs: this.ctx.clock.nowMs(),
      stale: false,
      lastError: null,
      oracle: snapshot.oracle,
      params,
      next,
      live: byEpoch.get(snapshot.currentEpoch - 1) ?? null,
      expired: byEpoch.get(snapshot.currentEpoch - 2) ?? null,
      later: next
        ? {
            epoch: snapshot.currentEpoch + 1,
            startTime: next.lockTime,
            lockTime: next.lockTime === null ? null : next.lockTime + params.intervalSeconds,
          }
        : null,
    };
    this.publish(this.current);
    return this.current;
  }

  /** Re-reads rounds that look final at the head at `head − CONFIRMATIONS`; returns those final there too. */
  private async confirmFinal(
    snapshot: ChainSnapshot,
    params: ContractParams,
  ): Promise<Map<number, { record: RoundRecord; chainTime: number }>> {
    const out = new Map<number, { record: RoundRecord; chainTime: number }>();
    const market = this.markets.tradable();
    const candidates: RoundRecord[] = [];
    for (const r of snapshot.rounds) {
      if (r.startTime === null) continue;
      if (!FINAL_STATUSES.has(deriveRoundStatus(r, snapshot.blockTimestamp, params.bufferSeconds))) continue;
      if (!(await this.ctx.repos.rounds.get(market.id, r.epoch))?.isFinal) candidates.push(r);
    }
    if (candidates.length === 0) return out;
    const confirmations = BigInt(this.ctx.config.confirmations);
    if (confirmations === 0n) {
      for (const r of candidates) out.set(r.epoch, { record: r, chainTime: snapshot.blockTimestamp });
      return out;
    }
    try {
      const pin = snapshot.blockNumber - confirmations;
      const [head, records] = await Promise.all([
        this.ctx.reader.getHead(pin),
        this.ctx.reader.getRounds(
          candidates.map((r) => r.epoch),
          pin,
        ),
      ]);
      for (const r of records) {
        if (FINAL_STATUSES.has(deriveRoundStatus(r, head.blockTimestamp, params.bufferSeconds))) {
          out.set(r.epoch, { record: r, chainTime: head.blockTimestamp });
        }
      }
    } catch (err) {
      this.ctx.log.app.warn({ err }, 'confirmation read failed; will retry next tick');
    }
    return out;
  }

  private publish(state: MarketState): void {
    this.ctx.bus.emit('market', state);
    for (const l of this.listeners) {
      try {
        l(state);
      } catch (err) {
        this.ctx.log.app.error({ err }, 'market state listener failed');
      }
    }
  }
}
