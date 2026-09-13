/**
 * Schema migrations (embedded so the bundled server needs no loose files). Append new migrations; never
 * edit an applied one.
 *
 * Conventions: money = TEXT decimal wei (exceeds int64), prices = INTEGER with 8 decimals,
 * chain times = INTEGER unix seconds, application event times = INTEGER unix milliseconds.
 */
import type { Db } from './database.js';

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const MIGRATIONS: readonly { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE markets (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  underlying_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  chain TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('PANCAKESWAP_V2','PANCAKESWAP_V1','PRDT')),
  timing TEXT NOT NULL CHECK (timing IN ('TIMESTAMP','BLOCK')),
  tradable INTEGER NOT NULL DEFAULT 0 CHECK (tradable IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  interval_seconds INTEGER,
  buffer_seconds INTEGER,
  treasury_fee_bps INTEGER NOT NULL DEFAULT 300,
  min_bet_wei TEXT,
  oracle_address TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (chain_id, contract_address)
);

CREATE TABLE rounds (
  id INTEGER PRIMARY KEY,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  epoch INTEGER NOT NULL,
  start_time INTEGER,
  lock_time INTEGER,
  close_time INTEGER,
  start_block INTEGER,
  lock_block INTEGER,
  close_block INTEGER,
  lock_price INTEGER,
  close_price INTEGER,
  lock_oracle_id TEXT,
  close_oracle_id TEXT,
  total_amount TEXT NOT NULL DEFAULT '0',
  bull_amount TEXT NOT NULL DEFAULT '0',
  bear_amount TEXT NOT NULL DEFAULT '0',
  reward_base_cal_amount TEXT NOT NULL DEFAULT '0',
  reward_amount TEXT NOT NULL DEFAULT '0',
  oracle_called INTEGER NOT NULL DEFAULT 0 CHECK (oracle_called IN (0,1)),
  bull_payout REAL,
  bear_payout REAL,
  status TEXT NOT NULL CHECK (status IN ('UPCOMING','OPEN','LOCKING','LIVE','CLOSING','ENDED','CANCELLED')),
  outcome TEXT CHECK (outcome IN ('BULL','BEAR','TIE','CANCELLED')),
  is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0,1)),
  source TEXT NOT NULL CHECK (source IN ('CHAIN','CSV_IMPORT')),
  observed_block INTEGER,
  observed_at INTEGER,
  extra TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (market_id, epoch),
  CHECK (is_final = 0 OR outcome IS NOT NULL)
);
CREATE INDEX idx_rounds_market_close ON rounds(market_id, close_time);
CREATE INDEX idx_rounds_market_final ON rounds(market_id, is_final, epoch);
CREATE INDEX idx_rounds_outcome ON rounds(market_id, outcome);

-- Final round data can only be replaced by an authoritative chain observation of a CSV-imported row,
-- and every such correction is preserved in round_corrections.
CREATE TRIGGER rounds_final_immutable BEFORE UPDATE ON rounds
WHEN OLD.is_final = 1 AND NOT (OLD.source = 'CSV_IMPORT' AND NEW.source = 'CHAIN') AND (
  NEW.is_final IS NOT OLD.is_final OR NEW.outcome IS NOT OLD.outcome OR
  NEW.lock_price IS NOT OLD.lock_price OR NEW.close_price IS NOT OLD.close_price OR
  NEW.bull_amount IS NOT OLD.bull_amount OR NEW.bear_amount IS NOT OLD.bear_amount OR
  NEW.reward_amount IS NOT OLD.reward_amount OR NEW.reward_base_cal_amount IS NOT OLD.reward_base_cal_amount)
BEGIN
  SELECT RAISE(ABORT, 'final round data is immutable');
END;

CREATE TABLE round_corrections (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  previous TEXT NOT NULL,
  corrected TEXT NOT NULL,
  source TEXT NOT NULL,
  detected_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE VIEW rounds_v AS
SELECT r.*,
  CASE WHEN p.lock_time IS NOT NULL AND r.start_time IS NOT NULL AND abs(r.start_time - p.lock_time) <= 60
       THEN p.lock_price END AS start_price
FROM rounds r
LEFT JOIN rounds p ON p.market_id = r.market_id AND p.epoch = r.epoch - 1;

CREATE TABLE sync_state (
  market_id INTEGER PRIMARY KEY REFERENCES markets(id),
  last_synced_epoch INTEGER,
  last_sync_at TEXT,
  last_reconcile_at TEXT,
  reconcile_cursor INTEGER
);

CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  source TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT ${NOW},
  finished_at TEXT,
  rows_read INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  duplicates_identical INTEGER NOT NULL DEFAULT 0,
  duplicates_conflicting INTEGER NOT NULL DEFAULT 0,
  malformed INTEGER NOT NULL DEFAULT 0,
  conflicts_with_db INTEGER NOT NULL DEFAULT 0,
  report TEXT
);

CREATE TABLE wallets (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('SIGNER','WATCH')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  user_rounds_cursor INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE strategies (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  plugin TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  paper_trading_enabled INTEGER NOT NULL DEFAULT 1 CHECK (paper_trading_enabled IN (0,1)),
  live_trading_enabled INTEGER NOT NULL DEFAULT 0 CHECK (live_trading_enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE claims (
  id INTEGER PRIMARY KEY,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  market_id INTEGER NOT NULL REFERENCES markets(id),
  epochs TEXT NOT NULL,
  tx_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUBMITTED','CONFIRMED','FAILED')),
  gas_cost TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('PAPER','LIVE')),
  source TEXT NOT NULL CHECK (source IN ('BOT','MANUAL','IMPORTED')),
  wallet_id INTEGER REFERENCES wallets(id),
  market_id INTEGER NOT NULL REFERENCES markets(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  epoch INTEGER NOT NULL,
  strategy_id INTEGER REFERENCES strategies(id),
  decision_id INTEGER,
  direction TEXT NOT NULL CHECK (direction IN ('BULL','BEAR')),
  amount TEXT NOT NULL,
  entry_bull_payout REAL,
  entry_bear_payout REAL,
  placed_at INTEGER NOT NULL,
  tx_hash TEXT UNIQUE,
  nonce INTEGER,
  block_number INTEGER,
  gas_used TEXT,
  gas_price TEXT,
  gas_cost TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUBMITTING','SUBMITTED','CONFIRMED','SETTLED','FAILED')),
  result TEXT CHECK (result IN ('WON','LOST','REFUNDED')),
  payout TEXT,
  gross_pnl TEXT,
  net_pnl TEXT,
  claim_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE' CHECK (claim_status IN ('NOT_APPLICABLE','UNCLAIMED','CLAIMING','CLAIMED')),
  claim_id INTEGER REFERENCES claims(id),
  claim_gas_cost TEXT,
  error TEXT,
  error_class TEXT,
  settled_at INTEGER,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  CHECK (mode = 'PAPER' OR wallet_id IS NOT NULL),
  CHECK (status <> 'SETTLED' OR (result IS NOT NULL AND payout IS NOT NULL))
);
-- The contract accepts one bet per address per round; mirror that for live trades.
CREATE UNIQUE INDEX uniq_live_bet_per_round ON trades(wallet_id, market_id, epoch) WHERE mode = 'LIVE' AND status <> 'FAILED';
CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_mode_placed ON trades(mode, placed_at);
CREATE INDEX idx_trades_strategy ON trades(strategy_id);
CREATE INDEX idx_trades_round ON trades(round_id);

CREATE TABLE trade_events (
  id INTEGER PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX idx_trade_events_trade ON trade_events(trade_id);
CREATE TRIGGER trade_events_no_update BEFORE UPDATE ON trade_events BEGIN SELECT RAISE(ABORT, 'trade_events is append-only'); END;
CREATE TRIGGER trade_events_no_delete BEFORE DELETE ON trade_events BEGIN SELECT RAISE(ABORT, 'trade_events is append-only'); END;

CREATE TABLE strategy_decisions (
  id INTEGER PRIMARY KEY,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id),
  market_id INTEGER NOT NULL REFERENCES markets(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  epoch INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('PAPER','LIVE')),
  signal TEXT CHECK (signal IN ('BUY_UP','BUY_DOWN','WAIT','SKIP')),
  confidence REAL,
  decision TEXT NOT NULL CHECK (decision IN ('TRADE','NO_TRADE')),
  direction TEXT CHECK (direction IN ('BULL','BEAR')),
  intended_amount TEXT,
  actual_amount TEXT,
  expected_edge REAL,
  reason TEXT NOT NULL,
  rationale TEXT,
  risk_checks TEXT NOT NULL DEFAULT '[]',
  inputs TEXT,
  indicators TEXT,
  error TEXT,
  trade_id INTEGER REFERENCES trades(id),
  decided_at INTEGER NOT NULL,
  seconds_to_lock REAL,
  UNIQUE (strategy_id, round_id, mode)
);
CREATE INDEX idx_decisions_round ON strategy_decisions(round_id);
CREATE INDEX idx_decisions_decided ON strategy_decisions(decided_at);

CREATE TABLE portfolio_snapshots (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('PAPER','LIVE')),
  wallet_id INTEGER REFERENCES wallets(id),
  taken_at INTEGER NOT NULL,
  balance TEXT NOT NULL,
  available TEXT NOT NULL,
  deployed TEXT NOT NULL,
  claimable TEXT NOT NULL,
  realized_pnl TEXT NOT NULL,
  drawdown TEXT NOT NULL,
  roi REAL,
  win_rate REAL,
  loss_rate REAL,
  trades INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_mode_time ON portfolio_snapshots(mode, taken_at);

CREATE TABLE bot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('STOPPED','RUNNING','PAUSED','EMERGENCY_STOPPED')),
  status_reason TEXT,
  live_armed INTEGER NOT NULL DEFAULT 0 CHECK (live_armed IN (0,1)),
  live_armed_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
INSERT INTO bot_state (id, status, status_reason) VALUES (1, 'STOPPED', 'initial state');

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  component TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('DEBUG','INFO','WARN','ERROR','CRITICAL')),
  type TEXT NOT NULL,
  market_id INTEGER,
  epoch INTEGER,
  strategy_id INTEGER,
  trade_id INTEGER,
  tx_hash TEXT,
  message TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX idx_audit_ts ON audit_events(ts);
CREATE INDEX idx_audit_type ON audit_events(type);
CREATE INDEX idx_audit_epoch ON audit_events(epoch);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TABLE backtest_runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED')),
  request TEXT NOT NULL,
  result TEXT,
  error TEXT,
  progress REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  finished_at TEXT
);
`,
  },
  {
    id: 2,
    name: 'backtest runner heartbeat',
    sql: `ALTER TABLE backtest_runs ADD COLUMN heartbeat_at INTEGER;`,
  },
];

export function migrate(db: Db): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT ${NOW})`);
  const applied = new Set(db.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', [m.id, m.name]);
    });
    ran.push(m.id);
  }
  return ran;
}
