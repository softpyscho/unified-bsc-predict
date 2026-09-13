import type { ClaimStatus, Direction, TradeMode, TradeResult, TradeSource, TradeStatus } from '@bsc/core';
import { assertTransition } from '@bsc/core';
import type { Db } from '../db/database.js';
import { big, bigStr, nowIso } from '../db/database.js';
import { parseJson, stringify } from '../util/json.js';

export interface Trade {
  id: number;
  uid: string;
  mode: TradeMode;
  source: TradeSource;
  walletId: number | null;
  marketId: number;
  roundId: number;
  epoch: number;
  strategyId: number | null;
  decisionId: number | null;
  direction: Direction;
  amount: bigint;
  entryBullPayout: number | null;
  entryBearPayout: number | null;
  placedAt: number;
  txHash: string | null;
  nonce: number | null;
  blockNumber: number | null;
  gasUsed: bigint | null;
  gasPrice: bigint | null;
  gasCost: bigint | null;
  status: TradeStatus;
  result: TradeResult | null;
  payout: bigint | null;
  grossPnl: bigint | null;
  netPnl: bigint | null;
  claimStatus: ClaimStatus;
  claimId: number | null;
  claimGasCost: bigint | null;
  error: string | null;
  errorClass: string | null;
  settledAt: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTrade {
  uid: string;
  mode: TradeMode;
  source: TradeSource;
  walletId: number | null;
  marketId: number;
  roundId: number;
  epoch: number;
  strategyId: number | null;
  decisionId: number | null;
  direction: Direction;
  amount: bigint;
  entryBullPayout: number | null;
  entryBearPayout: number | null;
  placedAt: number;
  status: 'PENDING' | 'CONFIRMED';
  gasCost?: bigint | null;
  claimStatus?: ClaimStatus;
}

/** Mutable non-status fields. Status changes must go through `transition`. */
export interface TradePatch {
  txHash?: string | null;
  nonce?: number | null;
  blockNumber?: number | null;
  gasUsed?: bigint | null;
  gasPrice?: bigint | null;
  gasCost?: bigint | null;
  result?: TradeResult | null;
  payout?: bigint | null;
  grossPnl?: bigint | null;
  netPnl?: bigint | null;
  claimStatus?: ClaimStatus;
  claimId?: number | null;
  claimGasCost?: bigint | null;
  error?: string | null;
  errorClass?: string | null;
  settledAt?: number | null;
  decisionId?: number | null;
}

const COLUMNS: Record<keyof TradePatch, string> = {
  txHash: 'tx_hash',
  nonce: 'nonce',
  blockNumber: 'block_number',
  gasUsed: 'gas_used',
  gasPrice: 'gas_price',
  gasCost: 'gas_cost',
  result: 'result',
  payout: 'payout',
  grossPnl: 'gross_pnl',
  netPnl: 'net_pnl',
  claimStatus: 'claim_status',
  claimId: 'claim_id',
  claimGasCost: 'claim_gas_cost',
  error: 'error',
  errorClass: 'error_class',
  settledAt: 'settled_at',
  decisionId: 'decision_id',
};

interface Row {
  id: number;
  uid: string;
  mode: TradeMode;
  source: TradeSource;
  wallet_id: number | null;
  market_id: number;
  round_id: number;
  epoch: number;
  strategy_id: number | null;
  decision_id: number | null;
  direction: Direction;
  amount: string;
  entry_bull_payout: number | null;
  entry_bear_payout: number | null;
  placed_at: number;
  tx_hash: string | null;
  nonce: number | null;
  block_number: number | null;
  gas_used: string | null;
  gas_price: string | null;
  gas_cost: string | null;
  status: TradeStatus;
  result: TradeResult | null;
  payout: string | null;
  gross_pnl: string | null;
  net_pnl: string | null;
  claim_status: ClaimStatus;
  claim_id: number | null;
  claim_gas_cost: string | null;
  error: string | null;
  error_class: string | null;
  settled_at: number | null;
  created_at: string;
  updated_at: string;
}

const map = (r: Row): Trade => ({
  id: r.id,
  uid: r.uid,
  mode: r.mode,
  source: r.source,
  walletId: r.wallet_id,
  marketId: r.market_id,
  roundId: r.round_id,
  epoch: r.epoch,
  strategyId: r.strategy_id,
  decisionId: r.decision_id,
  direction: r.direction,
  amount: BigInt(r.amount),
  entryBullPayout: r.entry_bull_payout,
  entryBearPayout: r.entry_bear_payout,
  placedAt: r.placed_at,
  txHash: r.tx_hash,
  nonce: r.nonce,
  blockNumber: r.block_number,
  gasUsed: big(r.gas_used),
  gasPrice: big(r.gas_price),
  gasCost: big(r.gas_cost),
  status: r.status,
  result: r.result,
  payout: big(r.payout),
  grossPnl: big(r.gross_pnl),
  netPnl: big(r.net_pnl),
  claimStatus: r.claim_status,
  claimId: r.claim_id,
  claimGasCost: big(r.claim_gas_cost),
  error: r.error,
  errorClass: r.error_class,
  settledAt: r.settled_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class ConcurrentModificationError extends Error {
  constructor(id: number, expected: TradeStatus) {
    super(`Trade ${id} is no longer in status ${expected}`);
    this.name = 'ConcurrentModificationError';
  }
}

export interface TradeFilter {
  mode?: TradeMode;
  source?: TradeSource;
  strategyId?: number;
  marketId?: number;
  walletId?: number;
  direction?: Direction;
  status?: TradeStatus;
  result?: TradeResult;
  epoch?: number;
  fromTime?: number;
  toTime?: number;
  minAmountWei?: bigint;
  maxAmountWei?: bigint;
}

function whereFor(f: TradeFilter): { clause: string; params: Record<string, string | number> } {
  const w: string[] = [];
  const p: Record<string, string | number> = {};
  const eq = (col: string, key: string, v: string | number | undefined) => {
    if (v !== undefined) {
      w.push(`${col} = :${key}`);
      p[key] = v;
    }
  };
  eq('mode', 'mode', f.mode);
  eq('source', 'source', f.source);
  eq('strategy_id', 'strategyId', f.strategyId);
  eq('market_id', 'marketId', f.marketId);
  eq('wallet_id', 'walletId', f.walletId);
  eq('direction', 'direction', f.direction);
  eq('status', 'status', f.status);
  eq('result', 'result', f.result);
  eq('epoch', 'epoch', f.epoch);
  const cmp = (sql: string, key: string, v: number | undefined) => {
    if (v === undefined) return;
    w.push(sql);
    p[key] = v;
  };
  cmp('placed_at >= :fromTime', 'fromTime', f.fromTime);
  cmp('placed_at <= :toTime', 'toTime', f.toTime);
  // Amount filters are display filters; exact accounting never relies on them.
  cmp(
    'CAST(amount AS REAL) >= :minAmount',
    'minAmount',
    f.minAmountWei === undefined ? undefined : Number(f.minAmountWei),
  );
  cmp(
    'CAST(amount AS REAL) <= :maxAmount',
    'maxAmount',
    f.maxAmountWei === undefined ? undefined : Number(f.maxAmountWei),
  );
  return { clause: w.length > 0 ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

export class TradesRepo {
  constructor(private readonly db: Db) {}

  insert(t: NewTrade, detail: string): Trade {
    return this.db.tx(() => {
      const id = this.db.run(
        `INSERT INTO trades (uid, mode, source, wallet_id, market_id, round_id, epoch, strategy_id, decision_id, direction,
           amount, entry_bull_payout, entry_bear_payout, placed_at, status, gas_cost, claim_status)
         VALUES (:uid, :mode, :source, :walletId, :marketId, :roundId, :epoch, :strategyId, :decisionId, :direction,
           :amount, :bull, :bear, :placedAt, :status, :gasCost, :claimStatus)`,
        {
          uid: t.uid,
          mode: t.mode,
          source: t.source,
          walletId: t.walletId,
          marketId: t.marketId,
          roundId: t.roundId,
          epoch: t.epoch,
          strategyId: t.strategyId,
          decisionId: t.decisionId,
          direction: t.direction,
          amount: t.amount.toString(),
          bull: t.entryBullPayout,
          bear: t.entryBearPayout,
          placedAt: t.placedAt,
          status: t.status,
          gasCost: bigStr(t.gasCost ?? null),
          claimStatus: t.claimStatus ?? 'NOT_APPLICABLE',
        },
      ).lastInsertRowid;
      this.event(id, null, t.status, detail);
      return this.get(id)!;
    });
  }

  get(id: number): Trade | undefined {
    const r = this.db.get<Row>('SELECT * FROM trades WHERE id = ?', [id]);
    return r ? map(r) : undefined;
  }

  byUid(uid: string): Trade | undefined {
    const r = this.db.get<Row>('SELECT * FROM trades WHERE uid = ?', [uid]);
    return r ? map(r) : undefined;
  }

  byTxHash(hash: string): Trade | undefined {
    const r = this.db.get<Row>('SELECT * FROM trades WHERE tx_hash = ?', [hash]);
    return r ? map(r) : undefined;
  }

  /** Guarded status change: validates the transition and fails if another writer changed the trade first. */
  transition(id: number, from: TradeStatus, to: TradeStatus, patch: TradePatch, detail: string): Trade {
    assertTransition(from, to);
    return this.db.tx(() => {
      const { sets, params } = this.patchSql(patch);
      const res = this.db.run(
        `UPDATE trades SET status = :to, ${sets.length > 0 ? `${sets.join(', ')}, ` : ''}updated_at = :now
         WHERE id = :id AND status = :from`,
        { ...params, to, from, id, now: nowIso() },
      );
      if (res.changes !== 1) throw new ConcurrentModificationError(id, from);
      this.event(id, from, to, detail);
      return this.get(id)!;
    });
  }

  /** Updates non-status fields (e.g. claim bookkeeping); recorded in trade_events. */
  patch(id: number, patch: TradePatch, detail: string): Trade {
    return this.db.tx(() => {
      const { sets, params } = this.patchSql(patch);
      if (sets.length === 0) return this.get(id)!;
      this.db.run(`UPDATE trades SET ${sets.join(', ')}, updated_at = :now WHERE id = :id`, {
        ...params,
        id,
        now: nowIso(),
      });
      const t = this.get(id)!;
      this.event(id, t.status, t.status, detail);
      return t;
    });
  }

  private patchSql(patch: TradePatch): { sets: string[]; params: Record<string, string | number | null> } {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(patch) as [keyof TradePatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${COLUMNS[key]} = :p_${key}`);
      params[`p_${key}`] = typeof value === 'bigint' ? value.toString() : (value as string | number | null);
    }
    return { sets, params };
  }

  private event(tradeId: number, from: TradeStatus | null, to: TradeStatus, detail: string): void {
    this.db.run(
      'INSERT INTO trade_events (trade_id, from_status, to_status, at, detail) VALUES (?, ?, ?, ?, ?)',
      [tradeId, from, to, Date.now(), detail],
    );
  }

  events(
    tradeId: number,
  ): { fromStatus: TradeStatus | null; toStatus: TradeStatus; at: number; detail: string | null }[] {
    return this.db
      .all<{ from_status: TradeStatus | null; to_status: TradeStatus; at: number; detail: string | null }>(
        'SELECT * FROM trade_events WHERE trade_id = ? ORDER BY id',
        [tradeId],
      )
      .map((r) => ({ fromStatus: r.from_status, toStatus: r.to_status, at: r.at, detail: r.detail }));
  }

  list(
    f: TradeFilter,
    page: { limit: number; offset: number; order: 'asc' | 'desc' },
  ): { rows: Trade[]; total: number } {
    const { clause, params } = whereFor(f);
    const total = this.db.get<{ n: number }>(`SELECT count(*) AS n FROM trades ${clause}`, params)!.n;
    const rows = this.db
      .all<Row>(
        `SELECT * FROM trades ${clause} ORDER BY placed_at ${page.order === 'asc' ? 'ASC' : 'DESC'}, id DESC LIMIT :limit OFFSET :offset`,
        {
          ...params,
          limit: page.limit,
          offset: page.offset,
        },
      )
      .map(map);
    return { rows, total };
  }

  /** All matching trades (for analytics). */
  all(f: TradeFilter): Trade[] {
    const { clause, params } = whereFor(f);
    return this.db.all<Row>(`SELECT * FROM trades ${clause} ORDER BY placed_at, id`, params).map(map);
  }

  byStatus(statuses: readonly TradeStatus[], mode?: TradeMode): Trade[] {
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.all<Row>(
      `SELECT * FROM trades WHERE status IN (${placeholders}) ${mode ? 'AND mode = ?' : ''} ORDER BY id`,
      mode ? [...statuses, mode] : [...statuses],
    );
    return rows.map(map);
  }

  forRound(roundId: number): Trade[] {
    return this.db.all<Row>('SELECT * FROM trades WHERE round_id = ? ORDER BY id', [roundId]).map(map);
  }

  /** Confirmed trades whose round has become final — ready to settle. */
  settleable(): Trade[] {
    return this.db
      .all<Row>(
        `SELECT t.* FROM trades t JOIN rounds r ON r.id = t.round_id
         WHERE t.status = 'CONFIRMED' AND r.is_final = 1 ORDER BY t.id`,
      )
      .map(map);
  }

  findLive(walletId: number, marketId: number, epoch: number): Trade | undefined {
    const r = this.db.get<Row>(
      `SELECT * FROM trades WHERE mode = 'LIVE' AND wallet_id = ? AND market_id = ? AND epoch = ? AND status <> 'FAILED'`,
      [walletId, marketId, epoch],
    );
    return r ? map(r) : undefined;
  }

  unclaimed(walletId: number, marketId: number): Trade[] {
    return this.db
      .all<Row>(
        `SELECT * FROM trades WHERE mode = 'LIVE' AND wallet_id = ? AND market_id = ? AND status = 'SETTLED'
           AND claim_status = 'UNCLAIMED' ORDER BY epoch`,
        [walletId, marketId],
      )
      .map(map);
  }
}

export interface Claim {
  id: number;
  walletId: number;
  marketId: number;
  epochs: number[];
  txHash: string | null;
  status: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
  gasCost: bigint | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ClaimsRepo {
  constructor(private readonly db: Db) {}

  private map = (r: {
    id: number;
    wallet_id: number;
    market_id: number;
    epochs: string;
    tx_hash: string | null;
    status: Claim['status'];
    gas_cost: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
  }): Claim => ({
    id: r.id,
    walletId: r.wallet_id,
    marketId: r.market_id,
    epochs: parseJson<number[]>(r.epochs, []),
    txHash: r.tx_hash,
    status: r.status,
    gasCost: big(r.gas_cost),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  insert(c: { walletId: number; marketId: number; epochs: number[] }): Claim {
    const id = this.db.run(
      "INSERT INTO claims (wallet_id, market_id, epochs, status) VALUES (?, ?, ?, 'PENDING')",
      [c.walletId, c.marketId, stringify(c.epochs)],
    ).lastInsertRowid;
    return this.get(id)!;
  }

  get(id: number): Claim | undefined {
    const r = this.db.get<Parameters<ClaimsRepo['map']>[0]>('SELECT * FROM claims WHERE id = ?', [id]);
    return r ? this.map(r) : undefined;
  }

  update(
    id: number,
    p: { txHash?: string; status?: Claim['status']; gasCost?: bigint | null; error?: string | null },
  ): Claim {
    this.db.run(
      `UPDATE claims SET tx_hash = COALESCE(:txHash, tx_hash), status = COALESCE(:status, status),
         gas_cost = COALESCE(:gasCost, gas_cost), error = COALESCE(:error, error), updated_at = :now WHERE id = :id`,
      {
        id,
        txHash: p.txHash ?? null,
        status: p.status ?? null,
        gasCost: bigStr(p.gasCost ?? null),
        error: p.error ?? null,
        now: nowIso(),
      },
    );
    return this.get(id)!;
  }

  open(): Claim[] {
    return this.db
      .all<Parameters<ClaimsRepo['map']>[0]>(
        "SELECT * FROM claims WHERE status IN ('PENDING','SUBMITTED') ORDER BY id",
      )
      .map(this.map);
  }

  list(limit = 100): Claim[] {
    return this.db
      .all<Parameters<ClaimsRepo['map']>[0]>('SELECT * FROM claims ORDER BY id DESC LIMIT ?', [limit])
      .map(this.map);
  }
}
