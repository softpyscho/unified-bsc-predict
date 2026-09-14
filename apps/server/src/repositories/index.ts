import type { Db } from '../db/database.js';
import { DecisionsRepo } from './decisions.js';
import { MarketsRepo } from './markets.js';
import {
  AuditRepo,
  BacktestsRepo,
  BotStateRepo,
  SnapshotsRepo,
  StrategiesRepo,
  SyncRepo,
  WalletsRepo,
} from './misc.js';
import { PoolEventsRepo } from './poolEvents.js';
import { RoundsRepo } from './rounds.js';
import { ClaimsRepo, TradesRepo } from './trades.js';

export function createRepos(db: Db) {
  return {
    db,
    markets: new MarketsRepo(db),
    rounds: new RoundsRepo(db),
    trades: new TradesRepo(db),
    claims: new ClaimsRepo(db),
    decisions: new DecisionsRepo(db),
    strategies: new StrategiesRepo(db),
    wallets: new WalletsRepo(db),
    audit: new AuditRepo(db),
    bot: new BotStateRepo(db),
    snapshots: new SnapshotsRepo(db),
    backtests: new BacktestsRepo(db),
    sync: new SyncRepo(db),
    poolEvents: new PoolEventsRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;

export type { Market } from './markets.js';
export type { StoredRound, UpsertResult } from './rounds.js';
export type { Trade, TradePatch, Claim } from './trades.js';
export type { DecisionRecord } from './decisions.js';
export type { PoolEvent, PoolEventSync, RoundPoolCheck } from './poolEvents.js';
export type {
  StrategyRow,
  WalletRow,
  AuditEvent,
  AuditInput,
  BotStatus,
  BotStateRow,
  Severity,
} from './misc.js';
