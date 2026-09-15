import type { Db } from '../db/database.js';

export type ShadowOutcome = 'ACCEPTED' | 'REJECTED' | 'UNAVAILABLE';

export interface ShadowCheck {
  id: number;
  tradeId: number;
  checkedAt: number;
  blockNumber: number | null;
  secondsToLock: number | null;
  outcome: ShadowOutcome;
  errorClass: string | null;
  message: string | null;
  latencyMs: number;
}

const COLUMNS = `id, trade_id AS "tradeId", checked_at AS "checkedAt", block_number AS "blockNumber",
  seconds_to_lock AS "secondsToLock", outcome, error_class AS "errorClass", message, latency_ms AS "latencyMs"`;

export class ShadowRepo {
  constructor(private readonly db: Db) {}

  async insert(c: Omit<ShadowCheck, 'id'>): Promise<void> {
    await this.db.run(
      `INSERT INTO shadow_checks
         (trade_id, checked_at, block_number, seconds_to_lock, outcome, error_class, message, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (trade_id) DO NOTHING`,
      [
        c.tradeId,
        c.checkedAt,
        c.blockNumber,
        c.secondsToLock,
        c.outcome,
        c.errorClass,
        c.message?.slice(0, 500) ?? null,
        c.latencyMs,
      ],
    );
  }

  async forTrade(tradeId: number): Promise<ShadowCheck | null> {
    return (
      (await this.db.get<ShadowCheck>(`SELECT ${COLUMNS} FROM shadow_checks WHERE trade_id = ?`, [
        tradeId,
      ])) ?? null
    );
  }

  /** Acceptance of paper trades as live bets since `sinceMs`, with the reasons for rejections. */
  async summary(sinceMs: number) {
    const totals = (await this.db.get<{
      total: number;
      accepted: number;
      rejected: number;
      unavailable: number;
      stl_p10: number | null;
      stl_p50: number | null;
      lat_p50: number | null;
      lat_p95: number | null;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE outcome = 'ACCEPTED') AS accepted,
              count(*) FILTER (WHERE outcome = 'REJECTED') AS rejected,
              count(*) FILTER (WHERE outcome = 'UNAVAILABLE') AS unavailable,
              percentile_cont(0.1) WITHIN GROUP (ORDER BY seconds_to_lock) AS stl_p10,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds_to_lock) AS stl_p50,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS lat_p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS lat_p95
       FROM shadow_checks WHERE checked_at >= ?`,
      [sinceMs],
    ))!;
    const reasons = await this.db.all<{ outcome: ShadowOutcome; errorClass: string; n: number }>(
      `SELECT outcome, error_class AS "errorClass", count(*) AS n FROM shadow_checks
       WHERE checked_at >= ? AND outcome <> 'ACCEPTED' GROUP BY outcome, error_class ORDER BY n DESC`,
      [sinceMs],
    );
    const decided = totals.accepted + totals.rejected;
    return {
      sinceMs,
      total: totals.total,
      accepted: totals.accepted,
      rejected: totals.rejected,
      unavailable: totals.unavailable,
      /** Among checks that reached a verdict (network failures excluded). */
      acceptanceRate: decided ? totals.accepted / decided : null,
      reasons,
      secondsToLock: { p10: totals.stl_p10, p50: totals.stl_p50 },
      latencyMs: { p50: totals.lat_p50, p95: totals.lat_p95 },
    };
  }
}
