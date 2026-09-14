import type { Direction } from '@bsc/core';
import type { Db, SqlValue } from '../db/database.js';
import { nowIso } from '../db/database.js';

export interface PoolEvent {
  id: number;
  marketId: number;
  epoch: number;
  direction: Direction;
  sender: string;
  amount: bigint;
  blockNumber: number;
  blockTime: number;
  txHash: string;
  logIndex: number;
}

export interface NewPoolEvent {
  epoch: number;
  direction: Direction;
  sender: string;
  amount: bigint;
  blockNumber: bigint | number;
  blockTime: number;
  txHash: string;
  logIndex: number;
}

export interface PoolEventSync {
  anchorBlock: number;
  fromBlock: number;
  toBlock: number;
  backfillDone: boolean;
  backfillFailures: number;
  forwardFailures: number;
  lastError: string | null;
  updatedAt: string;
}

/** A final round's pool reconstructed from events, compared with the contract's totals. */
export interface RoundPoolCheck {
  epoch: number;
  events: number;
  bullAmount: bigint;
  bearAmount: bigint;
  eventBull: bigint;
  eventBear: bigint;
  complete: boolean;
}

interface EventRow {
  id: number;
  market_id: number;
  epoch: number;
  direction: Direction;
  sender: string;
  amount: string;
  block_number: number;
  block_time: number;
  tx_hash: string;
  log_index: number;
}

interface SyncRow {
  anchor_block: number;
  from_block: number;
  to_block: number;
  backfill_done: number;
  backfill_failures: number;
  forward_failures: number;
  last_error: string | null;
  updated_at: string;
}

const ROWS_PER_INSERT = 500;

const toEvent = (r: EventRow): PoolEvent => ({
  id: r.id,
  marketId: r.market_id,
  epoch: r.epoch,
  direction: r.direction,
  sender: r.sender,
  amount: BigInt(r.amount),
  blockNumber: r.block_number,
  blockTime: r.block_time,
  txHash: r.tx_hash,
  logIndex: r.log_index,
});

const toSync = (r: SyncRow): PoolEventSync => ({
  anchorBlock: r.anchor_block,
  fromBlock: r.from_block,
  toBlock: r.to_block,
  backfillDone: r.backfill_done === 1,
  backfillFailures: r.backfill_failures,
  forwardFailures: r.forward_failures,
  lastError: r.last_error,
  updatedAt: r.updated_at,
});

export class PoolEventsRepo {
  constructor(private readonly db: Db) {}

  async sync(marketId: number): Promise<PoolEventSync | null> {
    const r = await this.db.get<SyncRow>('SELECT * FROM pool_event_sync WHERE market_id = ?', [marketId]);
    return r ? toSync(r) : null;
  }

  /** Starts collection at `block` with an empty covered range; backfill then works down from there. */
  async initSync(marketId: number, block: number): Promise<PoolEventSync> {
    await this.db.run(
      `INSERT INTO pool_event_sync (market_id, anchor_block, from_block, to_block) VALUES (?, ?, ?, ?)
       ON CONFLICT (market_id) DO NOTHING`,
      [marketId, block, block, block - 1],
    );
    return (await this.sync(marketId))!;
  }

  /**
   * Stores events and widens the covered range in one transaction, so the range never claims blocks whose events
   * are missing. Events already stored (same tx hash and log index) are ignored. Returns the number inserted.
   */
  async append(
    marketId: number,
    events: readonly NewPoolEvent[],
    range: { fromBlock?: number; toBlock?: number },
  ): Promise<number> {
    return this.db.tx(async () => {
      let inserted = 0;
      for (let i = 0; i < events.length; i += ROWS_PER_INSERT) {
        const values: SqlValue[] = [];
        const tuples = events.slice(i, i + ROWS_PER_INSERT).map((e) => {
          values.push(
            marketId,
            e.epoch,
            e.direction,
            e.sender.toLowerCase(),
            e.amount.toString(),
            Number(e.blockNumber),
            e.blockTime,
            e.txHash.toLowerCase(),
            e.logIndex,
          );
          return '(?, ?, ?, ?, ?, ?, ?, ?, ?)';
        });
        const res = await this.db.run(
          `INSERT INTO round_pool_events
             (market_id, epoch, direction, sender, amount, block_number, block_time, tx_hash, log_index)
           VALUES ${tuples.join(', ')} ON CONFLICT (market_id, tx_hash, log_index) DO NOTHING`,
          values,
        );
        inserted += res.changes;
      }
      const now = nowIso();
      if (range.fromBlock !== undefined)
        await this.db.run(
          `UPDATE pool_event_sync SET from_block = LEAST(from_block, ?), backfill_failures = 0, last_error = NULL,
             updated_at = ? WHERE market_id = ?`,
          [range.fromBlock, now, marketId],
        );
      if (range.toBlock !== undefined)
        await this.db.run(
          `UPDATE pool_event_sync SET to_block = GREATEST(to_block, ?), forward_failures = 0, last_error = NULL,
             updated_at = ? WHERE market_id = ?`,
          [range.toBlock, now, marketId],
        );
      return inserted;
    });
  }

  /** Counts a failed request; returns the consecutive failures for that direction. */
  async recordFailure(marketId: number, kind: 'forward' | 'backfill', error: string): Promise<number> {
    const col = kind === 'forward' ? 'forward_failures' : 'backfill_failures';
    const r = await this.db.get<{ n: number }>(
      `UPDATE pool_event_sync SET ${col} = ${col} + 1, last_error = ?, updated_at = ? WHERE market_id = ?
       RETURNING ${col} AS n`,
      [error.slice(0, 500), nowIso(), marketId],
    );
    return r?.n ?? 0;
  }

  /** Gives up on [fromBlock, toBlock]: records the gap and moves the forward cursor past it. */
  async skipGap(marketId: number, fromBlock: number, toBlock: number, reason: string): Promise<void> {
    await this.db.tx(async () => {
      await this.db.run(
        'INSERT INTO pool_event_gaps (market_id, from_block, to_block, reason) VALUES (?, ?, ?, ?)',
        [marketId, fromBlock, toBlock, reason.slice(0, 500)],
      );
      await this.db.run(
        `UPDATE pool_event_sync SET to_block = GREATEST(to_block, ?), forward_failures = 0, updated_at = ?
         WHERE market_id = ?`,
        [toBlock, nowIso(), marketId],
      );
    });
  }

  async setBackfillDone(marketId: number, done: boolean): Promise<void> {
    await this.db.run(
      `UPDATE pool_event_sync SET backfill_done = ?, backfill_failures = 0, updated_at = ? WHERE market_id = ?`,
      [done ? 1 : 0, nowIso(), marketId],
    );
  }

  async gaps(
    marketId: number,
  ): Promise<{ fromBlock: number; toBlock: number; reason: string; createdAt: string }[]> {
    return this.db.all(
      `SELECT from_block AS "fromBlock", to_block AS "toBlock", reason, created_at AS "createdAt"
       FROM pool_event_gaps WHERE market_id = ? ORDER BY from_block`,
      [marketId],
    );
  }

  async forRound(marketId: number, epoch: number): Promise<PoolEvent[]> {
    return (
      await this.db.all<EventRow>(
        `SELECT * FROM round_pool_events WHERE market_id = ? AND epoch = ? ORDER BY block_number, log_index`,
        [marketId, epoch],
      )
    ).map(toEvent);
  }

  /**
   * The round's pool from bets in blocks timestamped strictly before `before` (unix seconds). A block with the
   * same timestamp as a decision may have been produced after it within that second, so it is excluded.
   */
  async poolBefore(
    marketId: number,
    epoch: number,
    before: number,
  ): Promise<{ bull: bigint; bear: bigint; bets: number }> {
    const r = (await this.db.get<{ bull: string; bear: string; bets: number }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'BULL'), 0) AS bull,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'BEAR'), 0) AS bear,
              count(*) AS bets
       FROM round_pool_events WHERE market_id = ? AND epoch = ? AND block_time < ?`,
      [marketId, epoch, before],
    ))!;
    return { bull: BigInt(r.bull), bear: BigInt(r.bear), bets: r.bets };
  }

  /** Completeness of final rounds in [fromEpoch, toEpoch]: event sums must equal the contract's pool exactly. */
  async check(marketId: number, fromEpoch: number, toEpoch: number): Promise<RoundPoolCheck[]> {
    const rows = await this.db.all<{
      epoch: number;
      events: number;
      bull_amount: string;
      bear_amount: string;
      event_bull: string;
      event_bear: string;
    }>(
      `SELECT r.epoch, r.bull_amount, r.bear_amount, count(e.id) AS events,
              COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'BULL'), 0) AS event_bull,
              COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'BEAR'), 0) AS event_bear
       FROM rounds r
       LEFT JOIN round_pool_events e ON e.market_id = r.market_id AND e.epoch = r.epoch
       WHERE r.market_id = ? AND r.epoch BETWEEN ? AND ? AND r.is_final = 1
       GROUP BY r.epoch, r.bull_amount, r.bear_amount
       ORDER BY r.epoch`,
      [marketId, fromEpoch, toEpoch],
    );
    return rows.map((r) => {
      const c = {
        epoch: r.epoch,
        events: r.events,
        bullAmount: BigInt(r.bull_amount),
        bearAmount: BigInt(r.bear_amount),
        eventBull: BigInt(r.event_bull),
        eventBear: BigInt(r.event_bear),
      };
      return { ...c, complete: c.eventBull === c.bullAmount && c.eventBear === c.bearAmount };
    });
  }

  async summary(marketId: number): Promise<{
    events: number;
    epochs: number;
    firstEpoch: number | null;
    lastEpoch: number | null;
    firstBlockTime: number | null;
    lastBlockTime: number | null;
  }> {
    return (await this.db.get(
      `SELECT count(*) AS events, count(DISTINCT epoch) AS epochs, min(epoch) AS "firstEpoch",
              max(epoch) AS "lastEpoch", min(block_time) AS "firstBlockTime", max(block_time) AS "lastBlockTime"
       FROM round_pool_events WHERE market_id = ?`,
      [marketId],
    ))!;
  }
}
