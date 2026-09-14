import type { Direction, RiskCheck, SignalAction, TradeMode } from '@bsc/core';
import type { Db } from '../db/database.js';
import { big, bigStr } from '../db/database.js';
import { parseJson, stringify } from '../util/json.js';

export interface DecisionRecord {
  id: number;
  strategyId: number;
  marketId: number;
  roundId: number;
  epoch: number;
  mode: TradeMode;
  signal: SignalAction | null;
  confidence: number | null;
  decision: 'TRADE' | 'NO_TRADE';
  direction: Direction | null;
  intendedAmount: bigint | null;
  actualAmount: bigint | null;
  expectedEdge: number | null;
  reason: string;
  rationale: string | null;
  riskChecks: RiskCheck[];
  inputs: Record<string, unknown> | null;
  indicators: Record<string, unknown> | null;
  error: string | null;
  tradeId: number | null;
  decidedAt: number;
  secondsToLock: number | null;
}

export type NewDecision = Omit<DecisionRecord, 'id'>;

interface Row {
  id: number;
  strategy_id: number;
  market_id: number;
  round_id: number;
  epoch: number;
  mode: TradeMode;
  signal: SignalAction | null;
  confidence: number | null;
  decision: 'TRADE' | 'NO_TRADE';
  direction: Direction | null;
  intended_amount: string | null;
  actual_amount: string | null;
  expected_edge: number | null;
  reason: string;
  rationale: string | null;
  risk_checks: string;
  inputs: string | null;
  indicators: string | null;
  error: string | null;
  trade_id: number | null;
  decided_at: number;
  seconds_to_lock: number | null;
}

const map = (r: Row): DecisionRecord => ({
  id: r.id,
  strategyId: r.strategy_id,
  marketId: r.market_id,
  roundId: r.round_id,
  epoch: r.epoch,
  mode: r.mode,
  signal: r.signal,
  confidence: r.confidence,
  decision: r.decision,
  direction: r.direction,
  intendedAmount: big(r.intended_amount),
  actualAmount: big(r.actual_amount),
  expectedEdge: r.expected_edge,
  reason: r.reason,
  rationale: r.rationale,
  riskChecks: parseJson<RiskCheck[]>(r.risk_checks, []),
  inputs: parseJson<Record<string, unknown> | null>(r.inputs, null),
  indicators: parseJson<Record<string, unknown> | null>(r.indicators, null),
  error: r.error,
  tradeId: r.trade_id,
  decidedAt: r.decided_at,
  secondsToLock: r.seconds_to_lock,
});

export class DecisionsRepo {
  constructor(private readonly db: Db) {}

  async insert(d: NewDecision): Promise<DecisionRecord> {
    const id = await this.db.insert(
      `INSERT INTO strategy_decisions (strategy_id, market_id, round_id, epoch, mode, signal, confidence, decision,
         direction, intended_amount, actual_amount, expected_edge, reason, rationale, risk_checks, inputs, indicators,
         error, trade_id, decided_at, seconds_to_lock)
       VALUES (:strategyId, :marketId, :roundId, :epoch, :mode, :signal, :confidence, :decision, :direction, :intended,
         :actual, :edge, :reason, :rationale, :checks, :inputs, :indicators, :error, :tradeId, :decidedAt, :stl)`,
      {
        strategyId: d.strategyId,
        marketId: d.marketId,
        roundId: d.roundId,
        epoch: d.epoch,
        mode: d.mode,
        signal: d.signal,
        confidence: d.confidence,
        decision: d.decision,
        direction: d.direction,
        intended: bigStr(d.intendedAmount),
        actual: bigStr(d.actualAmount),
        edge: d.expectedEdge,
        reason: d.reason,
        rationale: d.rationale,
        checks: stringify(d.riskChecks),
        inputs: d.inputs ? stringify(d.inputs) : null,
        indicators: d.indicators ? stringify(d.indicators) : null,
        error: d.error,
        tradeId: d.tradeId,
        decidedAt: d.decidedAt,
        stl: d.secondsToLock,
      },
    );
    return (await this.get(id))!;
  }

  async get(id: number): Promise<DecisionRecord | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM strategy_decisions WHERE id = ?', [id]);
    return r ? map(r) : undefined;
  }

  async exists(strategyId: number, roundId: number, mode: TradeMode): Promise<boolean> {
    return (
      (await this.db.get(
        'SELECT 1 FROM strategy_decisions WHERE strategy_id = ? AND round_id = ? AND mode = ?',
        [strategyId, roundId, mode],
      )) !== undefined
    );
  }

  async attachTrade(id: number, tradeId: number): Promise<void> {
    await this.db.run('UPDATE strategy_decisions SET trade_id = ? WHERE id = ?', [tradeId, id]);
  }

  async forRound(roundId: number): Promise<DecisionRecord[]> {
    return (
      await this.db.all<Row>('SELECT * FROM strategy_decisions WHERE round_id = ? ORDER BY id', [roundId])
    ).map(map);
  }

  async list(
    f: { strategyId?: number; mode?: TradeMode; decision?: 'TRADE' | 'NO_TRADE'; epoch?: number },
    page: { limit: number; offset: number },
  ): Promise<{ rows: DecisionRecord[]; total: number }> {
    const w: string[] = [];
    const p: Record<string, string | number> = {};
    const add = (sql: string, key: string, v: string | number | undefined) => {
      if (v === undefined) return;
      w.push(sql);
      p[key] = v;
    };
    add('strategy_id = :strategyId', 'strategyId', f.strategyId);
    add('mode = :mode', 'mode', f.mode);
    add('decision = :decision', 'decision', f.decision);
    add('epoch = :epoch', 'epoch', f.epoch);
    const clause = w.length > 0 ? `WHERE ${w.join(' AND ')}` : '';
    const total = (await this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM strategy_decisions ${clause}`,
      p,
    ))!.n;
    const rows = (
      await this.db.all<Row>(
        `SELECT * FROM strategy_decisions ${clause} ORDER BY id DESC LIMIT :limit OFFSET :offset`,
        {
          ...p,
          limit: page.limit,
          offset: page.offset,
        },
      )
    ).map(map);
    return { rows, total };
  }
}
