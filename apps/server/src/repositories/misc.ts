/** Smaller aggregates: strategies, wallets, audit log, bot state, snapshots, backtests, sync state. */
import type { StrategyConfig, TradeMode } from '@bsc/core';
import type { Db } from '../db/database.js';
import { bool, nowIso } from '../db/database.js';
import { parseJson, stringify } from '../util/json.js';

// ---------------------------------------------------------------------------------------------- strategies

export interface StrategyRow {
  id: number;
  slug: string;
  plugin: string;
  name: string;
  version: string;
  description: string;
  marketId: number;
  config: StrategyConfig;
  enabled: boolean;
  paperTradingEnabled: boolean;
  liveTradingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StrategyDbRow {
  id: number;
  slug: string;
  plugin: string;
  name: string;
  version: string;
  description: string;
  market_id: number;
  config: string;
  enabled: number;
  paper_trading_enabled: number;
  live_trading_enabled: number;
  created_at: string;
  updated_at: string;
}

const mapStrategy = (r: StrategyDbRow): StrategyRow => ({
  id: r.id,
  slug: r.slug,
  plugin: r.plugin,
  name: r.name,
  version: r.version,
  description: r.description,
  marketId: r.market_id,
  config: parseJson<StrategyConfig>(r.config, {} as StrategyConfig),
  enabled: r.enabled === 1,
  paperTradingEnabled: r.paper_trading_enabled === 1,
  liveTradingEnabled: r.live_trading_enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class StrategiesRepo {
  constructor(private readonly db: Db) {}

  list(): StrategyRow[] {
    return this.db.all<StrategyDbRow>('SELECT * FROM strategies ORDER BY id').map(mapStrategy);
  }

  get(id: number): StrategyRow | undefined {
    const r = this.db.get<StrategyDbRow>('SELECT * FROM strategies WHERE id = ?', [id]);
    return r ? mapStrategy(r) : undefined;
  }

  bySlug(slug: string): StrategyRow | undefined {
    const r = this.db.get<StrategyDbRow>('SELECT * FROM strategies WHERE slug = ?', [slug]);
    return r ? mapStrategy(r) : undefined;
  }

  /** Seeds a strategy; existing rows (and their operator-edited config) are left untouched. */
  insertIfMissing(s: Omit<StrategyRow, 'id' | 'createdAt' | 'updatedAt'>): StrategyRow {
    this.db.run(
      `INSERT INTO strategies (slug, plugin, name, version, description, market_id, config, enabled,
         paper_trading_enabled, live_trading_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET version = excluded.version,
         description = excluded.description`,
      [
        s.slug,
        s.plugin,
        s.name,
        s.version,
        s.description,
        s.marketId,
        stringify(s.config),
        bool(s.enabled),
        bool(s.paperTradingEnabled),
        bool(s.liveTradingEnabled),
      ],
    );
    return this.bySlug(s.slug)!;
  }

  updateConfig(id: number, config: StrategyConfig): StrategyRow {
    this.db.run('UPDATE strategies SET config = ?, updated_at = ? WHERE id = ?', [
      stringify(config),
      nowIso(),
      id,
    ]);
    return this.get(id)!;
  }

  setFlags(
    id: number,
    f: { enabled?: boolean; paperTradingEnabled?: boolean; liveTradingEnabled?: boolean },
  ): StrategyRow {
    const cur = this.get(id)!;
    this.db.run(
      'UPDATE strategies SET enabled = ?, paper_trading_enabled = ?, live_trading_enabled = ?, updated_at = ? WHERE id = ?',
      [
        bool(f.enabled ?? cur.enabled),
        bool(f.paperTradingEnabled ?? cur.paperTradingEnabled),
        bool(f.liveTradingEnabled ?? cur.liveTradingEnabled),
        nowIso(),
        id,
      ],
    );
    return this.get(id)!;
  }
}

// ---------------------------------------------------------------------------------------------- wallets

export interface WalletRow {
  id: number;
  address: string;
  label: string;
  kind: 'SIGNER' | 'WATCH';
  enabled: boolean;
  userRoundsCursor: number;
  lastSyncedAt: string | null;
  createdAt: string;
}

interface WalletDbRow {
  id: number;
  address: string;
  label: string;
  kind: 'SIGNER' | 'WATCH';
  enabled: number;
  user_rounds_cursor: number;
  last_synced_at: string | null;
  created_at: string;
}

const mapWallet = (r: WalletDbRow): WalletRow => ({
  id: r.id,
  address: r.address,
  label: r.label,
  kind: r.kind,
  enabled: r.enabled === 1,
  userRoundsCursor: r.user_rounds_cursor,
  lastSyncedAt: r.last_synced_at,
  createdAt: r.created_at,
});

export class WalletsRepo {
  constructor(private readonly db: Db) {}

  list(): WalletRow[] {
    return this.db.all<WalletDbRow>('SELECT * FROM wallets ORDER BY kind DESC, id').map(mapWallet);
  }

  get(id: number): WalletRow | undefined {
    const r = this.db.get<WalletDbRow>('SELECT * FROM wallets WHERE id = ?', [id]);
    return r ? mapWallet(r) : undefined;
  }

  byAddress(address: string): WalletRow | undefined {
    const r = this.db.get<WalletDbRow>('SELECT * FROM wallets WHERE lower(address) = lower(?)', [address]);
    return r ? mapWallet(r) : undefined;
  }

  signer(): WalletRow | undefined {
    const r = this.db.get<WalletDbRow>(
      "SELECT * FROM wallets WHERE kind = 'SIGNER' AND enabled = 1 ORDER BY id DESC LIMIT 1",
    );
    return r ? mapWallet(r) : undefined;
  }

  upsert(address: string, kind: 'SIGNER' | 'WATCH', label: string): WalletRow {
    const existing = this.byAddress(address);
    if (existing) {
      this.db.run('UPDATE wallets SET kind = ?, label = ?, enabled = 1 WHERE id = ?', [
        kind,
        label,
        existing.id,
      ]);
      if (kind === 'SIGNER')
        this.db.run("UPDATE wallets SET kind = 'WATCH' WHERE kind = 'SIGNER' AND id <> ?", [existing.id]);
      return this.get(existing.id)!;
    }
    if (kind === 'SIGNER') this.db.run("UPDATE wallets SET kind = 'WATCH' WHERE kind = 'SIGNER'");
    const id = this.db.run('INSERT INTO wallets (address, label, kind) VALUES (?, ?, ?)', [
      address,
      label,
      kind,
    ]).lastInsertRowid;
    return this.get(id)!;
  }

  setCursor(id: number, cursor: number): void {
    this.db.run('UPDATE wallets SET user_rounds_cursor = ?, last_synced_at = ? WHERE id = ?', [
      cursor,
      nowIso(),
      id,
    ]);
  }
}

// ---------------------------------------------------------------------------------------------- audit

export type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface AuditInput {
  component: string;
  severity: Severity;
  type: string;
  message: string;
  marketId?: number | null;
  epoch?: number | null;
  strategyId?: number | null;
  tradeId?: number | null;
  txHash?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditEvent extends Required<Omit<AuditInput, 'metadata'>> {
  id: number;
  ts: number;
  metadata: Record<string, unknown> | null;
}

interface AuditDbRow {
  id: number;
  ts: number;
  component: string;
  severity: Severity;
  type: string;
  market_id: number | null;
  epoch: number | null;
  strategy_id: number | null;
  trade_id: number | null;
  tx_hash: string | null;
  message: string;
  metadata: string | null;
}

const mapAudit = (r: AuditDbRow): AuditEvent => ({
  id: r.id,
  ts: r.ts,
  component: r.component,
  severity: r.severity,
  type: r.type,
  marketId: r.market_id,
  epoch: r.epoch,
  strategyId: r.strategy_id,
  tradeId: r.trade_id,
  txHash: r.tx_hash,
  message: r.message,
  metadata: parseJson<Record<string, unknown> | null>(r.metadata, null),
});

export class AuditRepo {
  constructor(private readonly db: Db) {}

  append(e: AuditInput): AuditEvent {
    const id = this.db.run(
      `INSERT INTO audit_events (ts, component, severity, type, market_id, epoch, strategy_id, trade_id, tx_hash, message, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Date.now(),
        e.component,
        e.severity,
        e.type,
        e.marketId ?? null,
        e.epoch ?? null,
        e.strategyId ?? null,
        e.tradeId ?? null,
        e.txHash ?? null,
        e.message,
        e.metadata ? stringify(e.metadata) : null,
      ],
    ).lastInsertRowid;
    return mapAudit(this.db.get<AuditDbRow>('SELECT * FROM audit_events WHERE id = ?', [id])!);
  }

  list(
    f: {
      type?: string;
      severity?: Severity;
      component?: string;
      epoch?: number;
      strategyId?: number;
      tradeId?: number;
      beforeId?: number;
    },
    limit: number,
  ): AuditEvent[] {
    const w: string[] = [];
    const p: Record<string, string | number> = { limit };
    const add = (sql: string, key: string, v: string | number | undefined) => {
      if (v === undefined || v === '') return;
      w.push(sql);
      p[key] = v;
    };
    add('type = :type', 'type', f.type);
    add('severity = :severity', 'severity', f.severity);
    add('component = :component', 'component', f.component);
    add('epoch = :epoch', 'epoch', f.epoch);
    add('strategy_id = :strategyId', 'strategyId', f.strategyId);
    add('trade_id = :tradeId', 'tradeId', f.tradeId);
    add('id < :beforeId', 'beforeId', f.beforeId);
    const clause = w.length > 0 ? `WHERE ${w.join(' AND ')}` : '';
    return this.db
      .all<AuditDbRow>(`SELECT * FROM audit_events ${clause} ORDER BY id DESC LIMIT :limit`, p)
      .map(mapAudit);
  }
}

// ---------------------------------------------------------------------------------------------- bot state

export type BotStatus = 'STOPPED' | 'RUNNING' | 'PAUSED' | 'EMERGENCY_STOPPED';

export interface BotStateRow {
  status: BotStatus;
  statusReason: string | null;
  liveArmed: boolean;
  liveArmedAt: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export class BotStateRepo {
  constructor(private readonly db: Db) {}

  get(): BotStateRow {
    const r = this.db.get<{
      status: BotStatus;
      status_reason: string | null;
      live_armed: number;
      live_armed_at: string | null;
      consecutive_failures: number;
      updated_at: string;
    }>('SELECT * FROM bot_state WHERE id = 1')!;
    return {
      status: r.status,
      statusReason: r.status_reason,
      liveArmed: r.live_armed === 1,
      liveArmedAt: r.live_armed_at,
      consecutiveFailures: r.consecutive_failures,
      updatedAt: r.updated_at,
    };
  }

  update(p: Partial<Omit<BotStateRow, 'updatedAt'>>): BotStateRow {
    const cur = this.get();
    const next = { ...cur, ...p };
    this.db.run(
      `UPDATE bot_state SET status = ?, status_reason = ?, live_armed = ?, live_armed_at = ?, consecutive_failures = ?,
         updated_at = ? WHERE id = 1`,
      [
        next.status,
        next.statusReason,
        bool(next.liveArmed),
        next.liveArmedAt,
        next.consecutiveFailures,
        nowIso(),
      ],
    );
    return this.get();
  }
}

// ---------------------------------------------------------------------------------------------- snapshots

export interface SnapshotRow {
  id: number;
  mode: TradeMode;
  walletId: number | null;
  takenAt: number;
  balance: bigint;
  available: bigint;
  deployed: bigint;
  claimable: bigint;
  realizedPnl: bigint;
  drawdown: bigint;
  roi: number | null;
  winRate: number | null;
  lossRate: number | null;
  trades: number;
}

export class SnapshotsRepo {
  constructor(private readonly db: Db) {}

  insert(s: Omit<SnapshotRow, 'id'>): void {
    this.db.run(
      `INSERT INTO portfolio_snapshots (mode, wallet_id, taken_at, balance, available, deployed, claimable, realized_pnl,
         drawdown, roi, win_rate, loss_rate, trades) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.mode,
        s.walletId,
        s.takenAt,
        s.balance.toString(),
        s.available.toString(),
        s.deployed.toString(),
        s.claimable.toString(),
        s.realizedPnl.toString(),
        s.drawdown.toString(),
        s.roi,
        s.winRate,
        s.lossRate,
        s.trades,
      ],
    );
  }

  list(mode: TradeMode, since: number, limit = 5000): SnapshotRow[] {
    return this.db
      .all<{
        id: number;
        mode: TradeMode;
        wallet_id: number | null;
        taken_at: number;
        balance: string;
        available: string;
        deployed: string;
        claimable: string;
        realized_pnl: string;
        drawdown: string;
        roi: number | null;
        win_rate: number | null;
        loss_rate: number | null;
        trades: number;
      }>(
        'SELECT * FROM portfolio_snapshots WHERE mode = ? AND taken_at >= ? ORDER BY taken_at DESC LIMIT ?',
        [mode, since, limit],
      )
      .reverse()
      .map((r) => ({
        id: r.id,
        mode: r.mode,
        walletId: r.wallet_id,
        takenAt: r.taken_at,
        balance: BigInt(r.balance),
        available: BigInt(r.available),
        deployed: BigInt(r.deployed),
        claimable: BigInt(r.claimable),
        realizedPnl: BigInt(r.realized_pnl),
        drawdown: BigInt(r.drawdown),
        roi: r.roi,
        winRate: r.win_rate,
        lossRate: r.loss_rate,
        trades: r.trades,
      }));
  }
}

// ---------------------------------------------------------------------------------------------- backtests

export interface BacktestRunRow {
  id: number;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  request: unknown;
  result: unknown;
  error: string | null;
  progress: number;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export class BacktestsRepo {
  constructor(private readonly db: Db) {}

  create(request: unknown): number {
    return this.db.run("INSERT INTO backtest_runs (status, request, heartbeat_at) VALUES ('RUNNING', ?, ?)", [
      stringify(request),
      Date.now(),
    ]).lastInsertRowid;
  }

  /** Also a heartbeat: another process may only treat a run as dead once its heartbeat is stale. */
  progress(id: number, progress: number): void {
    this.db.run('UPDATE backtest_runs SET progress = ?, heartbeat_at = ? WHERE id = ?', [
      progress,
      Date.now(),
      id,
    ]);
  }

  finish(id: number, result: unknown, durationMs: number): void {
    this.db.run(
      "UPDATE backtest_runs SET status = 'DONE', result = ?, progress = 1, duration_ms = ?, finished_at = ? WHERE id = ?",
      [stringify(result), durationMs, nowIso(), id],
    );
  }

  fail(id: number, error: string): void {
    this.db.run("UPDATE backtest_runs SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ?", [
      error,
      nowIso(),
      id,
    ]);
  }

  /** Marks runs left RUNNING by a crashed process as failed. */
  failInterrupted(staleMs = 60_000): number {
    // Runs owned by another live process (e.g. the CLI) keep heartbeating and are left alone.
    return this.db.run(
      `UPDATE backtest_runs SET status = 'FAILED', error = 'interrupted: runner stopped (process exit or crash)',
         finished_at = ? WHERE status = 'RUNNING' AND coalesce(heartbeat_at, 0) < ?`,
      [nowIso(), Date.now() - staleMs],
    ).changes;
  }

  get(id: number, withResult = true): BacktestRunRow | undefined {
    const r = this.db.get<{
      id: number;
      status: BacktestRunRow['status'];
      request: string;
      result: string | null;
      error: string | null;
      progress: number;
      duration_ms: number | null;
      created_at: string;
      finished_at: string | null;
    }>(
      `SELECT id, status, request, ${withResult ? 'result' : 'NULL AS result'}, error, progress, duration_ms, created_at, finished_at FROM backtest_runs WHERE id = ?`,
      [id],
    );
    if (!r) return undefined;
    return {
      id: r.id,
      status: r.status,
      request: parseJson(r.request, null),
      result: parseJson(r.result, null),
      error: r.error,
      progress: r.progress,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  }

  list(limit = 50): BacktestRunRow[] {
    return this.db
      .all<{ id: number }>('SELECT id FROM backtest_runs ORDER BY id DESC LIMIT ?', [limit])
      .map((r) => this.get(r.id, false)!);
  }
}

// ---------------------------------------------------------------------------------------------- sync state

export interface ImportStats {
  rowsRead: number;
  inserted: number;
  unchanged: number;
  duplicatesIdentical: number;
  duplicatesConflicting: number;
  malformed: number;
  conflictsWithDb: number;
}

export class SyncRepo {
  constructor(private readonly db: Db) {}

  get(marketId: number): {
    lastSyncedEpoch: number | null;
    lastSyncAt: string | null;
    lastReconcileAt: string | null;
    reconcileCursor: number | null;
  } {
    const r = this.db.get<{
      last_synced_epoch: number | null;
      last_sync_at: string | null;
      last_reconcile_at: string | null;
      reconcile_cursor: number | null;
    }>('SELECT * FROM sync_state WHERE market_id = ?', [marketId]);
    return {
      lastSyncedEpoch: r?.last_synced_epoch ?? null,
      lastSyncAt: r?.last_sync_at ?? null,
      lastReconcileAt: r?.last_reconcile_at ?? null,
      reconcileCursor: r?.reconcile_cursor ?? null,
    };
  }

  update(
    marketId: number,
    p: { lastSyncedEpoch?: number; synced?: boolean; reconciled?: boolean; reconcileCursor?: number },
  ): void {
    this.db.run('INSERT OR IGNORE INTO sync_state (market_id) VALUES (?)', [marketId]);
    const now = nowIso();
    this.db.run(
      `UPDATE sync_state SET last_synced_epoch = COALESCE(:epoch, last_synced_epoch),
         last_sync_at = CASE WHEN :synced = 1 THEN :now ELSE last_sync_at END,
         last_reconcile_at = CASE WHEN :reconciled = 1 THEN :now ELSE last_reconcile_at END,
         reconcile_cursor = COALESCE(:cursor, reconcile_cursor) WHERE market_id = :marketId`,
      {
        epoch: p.lastSyncedEpoch ?? null,
        synced: bool(p.synced ?? false),
        reconciled: bool(p.reconciled ?? false),
        cursor: p.reconcileCursor ?? null,
        now,
        marketId,
      },
    );
  }

  startImport(marketId: number, source: string): number {
    return this.db.run('INSERT INTO import_runs (market_id, source) VALUES (?, ?)', [marketId, source])
      .lastInsertRowid;
  }

  finishImport(id: number, s: ImportStats, report: unknown): void {
    this.db.run(
      `UPDATE import_runs SET finished_at = ?, rows_read = ?, inserted = ?, unchanged = ?, duplicates_identical = ?,
         duplicates_conflicting = ?, malformed = ?, conflicts_with_db = ?, report = ? WHERE id = ?`,
      [
        nowIso(),
        s.rowsRead,
        s.inserted,
        s.unchanged,
        s.duplicatesIdentical,
        s.duplicatesConflicting,
        s.malformed,
        s.conflictsWithDb,
        stringify(report),
        id,
      ],
    );
  }

  imports(limit = 20): unknown[] {
    return this.db.all('SELECT * FROM import_runs ORDER BY id DESC LIMIT ?', [limit]).map((r) => {
      const row = r as Record<string, unknown>;
      return { ...row, report: parseJson(row.report as string | null, null) };
    });
  }
}
