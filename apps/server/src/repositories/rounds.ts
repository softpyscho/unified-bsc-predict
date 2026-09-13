import type { FinalRound, RoundOutcome, RoundRecord, RoundStatus } from '@bsc/core';
import { payoutMultiplier } from '@bsc/core';
import type { Db } from '../db/database.js';
import { bool, nowIso } from '../db/database.js';
import { parseJson, stringify } from '../util/json.js';

export type RoundSource = 'CHAIN' | 'CSV_IMPORT';

export interface StoredRound extends RoundRecord {
  id: number;
  marketId: number;
  startBlock: number | null;
  lockBlock: number | null;
  closeBlock: number | null;
  startPrice: number | null;
  status: RoundStatus;
  outcome: RoundOutcome | null;
  isFinal: boolean;
  source: RoundSource;
  bullPayout: number | null;
  bearPayout: number | null;
  observedBlock: number | null;
  observedAt: number | null;
  extra: Record<string, unknown> | null;
  finalizedAt: string | null;
  updatedAt: string;
}

export interface RoundWrite {
  record: RoundRecord;
  status: RoundStatus;
  outcome: RoundOutcome | null;
  isFinal: boolean;
  source: RoundSource;
  treasuryFeeBps: number;
  observedBlock?: number | null;
  observedAt?: number | null;
  blocks?: { start: number | null; lock: number | null; close: number | null };
  extra?: Record<string, unknown> | null;
}

/**
 * inserted/updated/finalized: stored; unchanged: identical data; corrected: CSV row replaced by chain data
 * (old values kept in round_corrections); conflict: final data differs and was NOT overwritten;
 * stale: incoming non-final observation of an already-final round (ignored).
 */
export type UpsertResult =
  'inserted' | 'updated' | 'finalized' | 'unchanged' | 'corrected' | 'conflict' | 'stale';

interface Row {
  id: number;
  market_id: number;
  epoch: number;
  start_time: number | null;
  lock_time: number | null;
  close_time: number | null;
  start_block: number | null;
  lock_block: number | null;
  close_block: number | null;
  lock_price: number | null;
  close_price: number | null;
  start_price: number | null;
  lock_oracle_id: string | null;
  close_oracle_id: string | null;
  total_amount: string;
  bull_amount: string;
  bear_amount: string;
  reward_base_cal_amount: string;
  reward_amount: string;
  oracle_called: number;
  bull_payout: number | null;
  bear_payout: number | null;
  status: RoundStatus;
  outcome: RoundOutcome | null;
  is_final: number;
  source: RoundSource;
  observed_block: number | null;
  observed_at: number | null;
  extra: string | null;
  finalized_at: string | null;
  updated_at: string;
}

const map = (r: Row): StoredRound => ({
  id: r.id,
  marketId: r.market_id,
  epoch: r.epoch,
  startTime: r.start_time,
  lockTime: r.lock_time,
  closeTime: r.close_time,
  startBlock: r.start_block,
  lockBlock: r.lock_block,
  closeBlock: r.close_block,
  lockPrice: r.lock_price,
  closePrice: r.close_price,
  startPrice: r.start_price ?? null,
  lockOracleId: r.lock_oracle_id,
  closeOracleId: r.close_oracle_id,
  totalAmount: BigInt(r.total_amount),
  bullAmount: BigInt(r.bull_amount),
  bearAmount: BigInt(r.bear_amount),
  rewardBaseCalAmount: BigInt(r.reward_base_cal_amount),
  rewardAmount: BigInt(r.reward_amount),
  oracleCalled: r.oracle_called === 1,
  bullPayout: r.bull_payout,
  bearPayout: r.bear_payout,
  status: r.status,
  outcome: r.outcome,
  isFinal: r.is_final === 1,
  source: r.source,
  observedBlock: r.observed_block,
  observedAt: r.observed_at,
  extra: parseJson<Record<string, unknown> | null>(r.extra, null),
  finalizedAt: r.finalized_at,
  updatedAt: r.updated_at,
});

function sameData(a: StoredRound, w: RoundWrite): boolean {
  const b = w.record;
  return (
    a.startTime === b.startTime &&
    a.lockTime === b.lockTime &&
    a.closeTime === b.closeTime &&
    a.lockPrice === b.lockPrice &&
    a.closePrice === b.closePrice &&
    a.totalAmount === b.totalAmount &&
    a.bullAmount === b.bullAmount &&
    a.bearAmount === b.bearAmount &&
    a.rewardBaseCalAmount === b.rewardBaseCalAmount &&
    a.rewardAmount === b.rewardAmount &&
    a.oracleCalled === b.oracleCalled &&
    a.status === w.status &&
    a.outcome === w.outcome &&
    a.isFinal === w.isFinal
  );
}

export function finalDataEqual(a: RoundRecord, b: RoundRecord): boolean {
  return (
    a.lockPrice === b.lockPrice &&
    a.closePrice === b.closePrice &&
    a.bullAmount === b.bullAmount &&
    a.bearAmount === b.bearAmount &&
    a.rewardAmount === b.rewardAmount &&
    a.rewardBaseCalAmount === b.rewardBaseCalAmount &&
    a.oracleCalled === b.oracleCalled
  );
}

export interface RoundFilter {
  marketId: number;
  fromEpoch?: number;
  toEpoch?: number;
  fromTime?: number;
  toTime?: number;
  outcome?: RoundOutcome;
  status?: RoundStatus;
  finalOnly?: boolean;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}

export class RoundsRepo {
  private readonly statsCache = new Map<number, { at: number; value: ReturnType<RoundsRepo['stats']> }>();

  constructor(private readonly db: Db) {}

  get(marketId: number, epoch: number): StoredRound | undefined {
    const r = this.db.get<Row>('SELECT * FROM rounds_v WHERE market_id = ? AND epoch = ?', [marketId, epoch]);
    return r ? map(r) : undefined;
  }

  getById(id: number): StoredRound | undefined {
    const r = this.db.get<Row>('SELECT * FROM rounds_v WHERE id = ?', [id]);
    return r ? map(r) : undefined;
  }

  upsert(
    marketId: number,
    w: RoundWrite,
  ): { result: UpsertResult; round: StoredRound; previous?: StoredRound } {
    return this.db.tx(() => {
      const existing = this.get(marketId, w.record.epoch);
      if (existing) {
        if (existing.isFinal) {
          if (!w.isFinal) return { result: 'stale' as const, round: existing };
          if (finalDataEqual(existing, w.record) && existing.outcome === w.outcome) {
            if (existing.source === 'CSV_IMPORT' && w.source === 'CHAIN')
              this.write(existing.id, marketId, w, true);
            return { result: 'unchanged' as const, round: existing };
          }
          if (existing.source === 'CSV_IMPORT' && w.source === 'CHAIN') {
            this.db.run(
              'INSERT INTO round_corrections (round_id, previous, corrected, source) VALUES (?, ?, ?, ?)',
              [existing.id, stringify(existing), stringify(w.record), w.source],
            );
            this.write(existing.id, marketId, w, true);
            return { result: 'corrected' as const, round: this.getById(existing.id)!, previous: existing };
          }
          return { result: 'conflict' as const, round: existing };
        }
        if (sameData(existing, w)) return { result: 'unchanged' as const, round: existing };
        this.write(existing.id, marketId, w, w.isFinal);
        return {
          result: w.isFinal ? ('finalized' as const) : ('updated' as const),
          round: this.getById(existing.id)!,
          previous: existing,
        };
      }
      const id = this.write(null, marketId, w, w.isFinal);
      return { result: 'inserted' as const, round: this.getById(id)! };
    });
  }

  private write(id: number | null, marketId: number, w: RoundWrite, finalizing: boolean): number {
    const r = w.record;
    const params = {
      marketId,
      epoch: r.epoch,
      startTime: r.startTime,
      lockTime: r.lockTime,
      closeTime: r.closeTime,
      startBlock: w.blocks?.start ?? null,
      lockBlock: w.blocks?.lock ?? null,
      closeBlock: w.blocks?.close ?? null,
      lockPrice: r.lockPrice,
      closePrice: r.closePrice,
      lockOracleId: r.lockOracleId,
      closeOracleId: r.closeOracleId,
      total: r.totalAmount.toString(),
      bull: r.bullAmount.toString(),
      bear: r.bearAmount.toString(),
      base: r.rewardBaseCalAmount.toString(),
      reward: r.rewardAmount.toString(),
      oracleCalled: bool(r.oracleCalled),
      bullPayout: payoutMultiplier(r, 'BULL', w.treasuryFeeBps),
      bearPayout: payoutMultiplier(r, 'BEAR', w.treasuryFeeBps),
      status: w.status,
      outcome: w.outcome,
      isFinal: bool(w.isFinal),
      source: w.source,
      observedBlock: w.observedBlock ?? null,
      observedAt: w.observedAt ?? null,
      extra: w.extra ? stringify(w.extra) : null,
      finalizedAt: finalizing ? nowIso() : null,
    };
    if (id === null) {
      return this.db.run(
        `INSERT INTO rounds (market_id, epoch, start_time, lock_time, close_time, start_block, lock_block, close_block,
           lock_price, close_price, lock_oracle_id, close_oracle_id, total_amount, bull_amount, bear_amount,
           reward_base_cal_amount, reward_amount, oracle_called, bull_payout, bear_payout, status, outcome, is_final,
           source, observed_block, observed_at, extra, finalized_at)
         VALUES (:marketId, :epoch, :startTime, :lockTime, :closeTime, :startBlock, :lockBlock, :closeBlock, :lockPrice,
           :closePrice, :lockOracleId, :closeOracleId, :total, :bull, :bear, :base, :reward, :oracleCalled, :bullPayout,
           :bearPayout, :status, :outcome, :isFinal, :source, :observedBlock, :observedAt, :extra, :finalizedAt)`,
        params,
      ).lastInsertRowid;
    }
    const { marketId: _marketId, epoch: _epoch, ...updateParams } = params;
    this.db.run(
      `UPDATE rounds SET start_time = :startTime, lock_time = :lockTime, close_time = :closeTime,
         start_block = COALESCE(:startBlock, start_block), lock_block = COALESCE(:lockBlock, lock_block),
         close_block = COALESCE(:closeBlock, close_block), lock_price = :lockPrice, close_price = :closePrice,
         lock_oracle_id = :lockOracleId, close_oracle_id = :closeOracleId, total_amount = :total, bull_amount = :bull,
         bear_amount = :bear, reward_base_cal_amount = :base, reward_amount = :reward, oracle_called = :oracleCalled,
         bull_payout = :bullPayout, bear_payout = :bearPayout, status = :status, outcome = :outcome,
         is_final = :isFinal, source = :source, observed_block = :observedBlock, observed_at = :observedAt,
         extra = COALESCE(:extra, extra), finalized_at = COALESCE(finalized_at, :finalizedAt), updated_at = :now
       WHERE id = :id`,
      { ...updateParams, id, now: nowIso() },
    );
    return id;
  }

  list(f: RoundFilter): { rows: StoredRound[]; total: number } {
    const where = ['market_id = :marketId'];
    const p: Record<string, number | string> = { marketId: f.marketId };
    const add = (sql: string, key: string, v: string | number | undefined) => {
      if (v === undefined) return;
      where.push(sql);
      p[key] = v;
    };
    add('epoch >= :fromEpoch', 'fromEpoch', f.fromEpoch);
    add('epoch <= :toEpoch', 'toEpoch', f.toEpoch);
    add('start_time >= :fromTime', 'fromTime', f.fromTime);
    add('start_time <= :toTime', 'toTime', f.toTime);
    add('outcome = :outcome', 'outcome', f.outcome);
    add('status = :status', 'status', f.status);
    if (f.finalOnly) where.push('is_final = 1');
    const clause = where.join(' AND ');
    const total = this.db.get<{ n: number }>(`SELECT count(*) AS n FROM rounds WHERE ${clause}`, p)!.n;
    const rows = this.db
      .all<Row>(
        `SELECT * FROM rounds_v WHERE ${clause} ORDER BY epoch ${f.order === 'asc' ? 'ASC' : 'DESC'} LIMIT :limit OFFSET :offset`,
        {
          ...p,
          limit: f.limit,
          offset: f.offset,
        },
      )
      .map(map);
    return { rows, total };
  }

  maxEpoch(marketId: number, finalOnly = false): number | null {
    const r = this.db.get<{ m: number | null }>(
      `SELECT max(epoch) AS m FROM rounds WHERE market_id = ? ${finalOnly ? 'AND is_final = 1' : ''}`,
      [marketId],
    );
    return r?.m ?? null;
  }

  /** Round counts for a market. `maxAgeMs` > 0 allows a cached value (dashboard endpoints). */
  stats(
    marketId: number,
    maxAgeMs = 0,
  ): {
    total: number;
    final: number;
    minEpoch: number | null;
    maxEpoch: number | null;
    bull: number;
    bear: number;
    tie: number;
    cancelled: number;
  } {
    const cached = this.statsCache.get(marketId);
    if (cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs) return cached.value;
    // Index-only queries (outcome index, unique (market, epoch), (market, is_final, epoch)).
    const byOutcome = new Map(
      this.db
        .all<{ outcome: string | null; n: number }>(
          'SELECT outcome, count(*) AS n FROM rounds WHERE market_id = ? GROUP BY outcome',
          [marketId],
        )
        .map((r) => [r.outcome, r.n]),
    );
    const span = this.db.get<{ minEpoch: number | null; maxEpoch: number | null }>(
      'SELECT min(epoch) AS minEpoch, max(epoch) AS maxEpoch FROM rounds WHERE market_id = ?',
      [marketId],
    )!;
    const final = this.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM rounds WHERE market_id = ? AND is_final = 1',
      [marketId],
    )!.n;
    const value = {
      total: [...byOutcome.values()].reduce((a, n) => a + n, 0),
      final,
      minEpoch: span.minEpoch,
      maxEpoch: span.maxEpoch,
      bull: byOutcome.get('BULL') ?? 0,
      bear: byOutcome.get('BEAR') ?? 0,
      tie: byOutcome.get('TIE') ?? 0,
      cancelled: byOutcome.get('CANCELLED') ?? 0,
    };
    this.statsCache.set(marketId, { at: Date.now(), value });
    return value;
  }

  /** Epochs in [from, to] that exist and are final. */
  finalEpochsIn(marketId: number, from: number, to: number): Set<number> {
    const rows = this.db.all<{ epoch: number }>(
      'SELECT epoch FROM rounds WHERE market_id = ? AND epoch BETWEEN ? AND ? AND is_final = 1',
      [marketId, from, to],
    );
    return new Set(rows.map((r) => r.epoch));
  }

  /** Non-final rounds at or below `maxEpoch` — reconciliation candidates. */
  nonFinal(marketId: number, maxEpoch: number, limit = 1000): StoredRound[] {
    return this.db
      .all<Row>(
        'SELECT * FROM rounds_v WHERE market_id = ? AND is_final = 0 AND epoch <= ? ORDER BY epoch LIMIT ?',
        [marketId, maxEpoch, limit],
      )
      .map(map);
  }

  /** The most recent final rounds before `beforeEpoch`, ascending — history for live strategy context. */
  recentFinal(marketId: number, beforeEpoch: number, limit: number): FinalRound[] {
    return this.db
      .all<Row>(
        'SELECT * FROM rounds_v WHERE market_id = ? AND epoch < ? AND is_final = 1 ORDER BY epoch DESC LIMIT ?',
        [marketId, beforeEpoch, limit],
      )
      .map(map)
      .reverse() as FinalRound[];
  }

  /** Final, timestamped rounds starting in [fromTime, toTime], ascending — backtest input. */
  finalForBacktest(marketId: number, fromTime: number, toTime: number): FinalRound[] {
    const out: FinalRound[] = [];
    for (const r of this.db.iterate<Row>(
      `SELECT * FROM rounds_v WHERE market_id = ? AND is_final = 1 AND start_time BETWEEN ? AND ?
         AND lock_time IS NOT NULL AND close_time IS NOT NULL ORDER BY epoch`,
      [marketId, fromTime, toTime],
    )) {
      out.push(map(r) as FinalRound);
    }
    return out;
  }

  corrections(
    roundId: number,
  ): { id: number; previous: unknown; corrected: unknown; source: string; detectedAt: string }[] {
    return this.db
      .all<{ id: number; previous: string; corrected: string; source: string; detected_at: string }>(
        'SELECT * FROM round_corrections WHERE round_id = ? ORDER BY id',
        [roundId],
      )
      .map((r) => ({
        id: r.id,
        previous: parseJson(r.previous, null),
        corrected: parseJson(r.corrected, null),
        source: r.source,
        detectedAt: r.detected_at,
      }));
  }

  /** Start times of the first and last final rounds (start time grows with epoch). */
  timeRange(marketId: number): { minStart: number | null; maxStart: number | null } {
    const at = (order: 'ASC' | 'DESC') =>
      this.db.get<{ t: number | null }>(
        `SELECT start_time AS t FROM rounds WHERE market_id = ? AND is_final = 1 ORDER BY epoch ${order} LIMIT 1`,
        [marketId],
      )?.t ?? null;
    return { minStart: at('ASC'), maxStart: at('DESC') };
  }
}
