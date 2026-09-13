# Operations

## Configuration

All settings come from the environment (`.env` is loaded automatically). The process validates everything at
startup and exits with a list of every problem. See `.env.example` for defaults.

| Variable                                           | Default                      | Notes                                                     |
| -------------------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| `ADMIN_API_TOKEN`                                  | — (required)                 | ≥ 24 chars; dashboard login / Bearer token                |
| `HOST`, `PORT`                                     | `127.0.0.1`, `8080`          | a warning is logged when not bound to loopback            |
| `DATABASE_URL`                                     | `file:./data/bsc-predict.db` | SQLite file (`:memory:` for tests)                        |
| `RPC_URL`, `RPC_URLS`                              | public BSC dataseeds         | fallback transport across all URLs                        |
| `CHAIN_ID`                                         | `56`                         | `97` for testnet                                          |
| `CONTRACT_ADDRESS`                                 | V2 `0x18B2…9cdA`             | the tradable prediction contract                          |
| `CONFIRMATIONS`                                    | `3`                          | depth used before a round is treated as final             |
| `PRIVATE_KEY`                                      | empty                        | signing key (live only); never stored, logged or returned |
| `WALLET_ADDRESS`                                   | empty                        | watch-only, or a consistency check against the key        |
| `LIVE_TRADING_ENABLED`                             | `false`                      | master switch for any transaction                         |
| `PAPER_TRADING_ENABLED`                            | `true`                       |                                                           |
| `PAPER_STARTING_BANKROLL`                          | `1`                          | BNB                                                       |
| `BOT_AUTO_RESUME_LIVE`                             | `false`                      | keep live armed across restarts                           |
| `DEFAULT_BET_SIZE`                                 | `0.001`                      | default fixed stake for seeded strategies                 |
| `MAX_BET_SIZE`                                     | `0.01`                       | per-trade cap                                             |
| `MAX_BANKROLL_FRACTION`                            | `0.05`                       | per-trade cap as a fraction of bankroll                   |
| `MAX_DAILY_LOSS`                                   | `0.05`                       | realized net loss per UTC day (per mode)                  |
| `MAX_CONSECUTIVE_LOSSES`, `COOLDOWN_ROUNDS`        | `5`, `12`                    | loss-streak cooldown                                      |
| `MAX_TOTAL_EXPOSURE`                               | `0.05`                       | stake in unsettled trades                                 |
| `MIN_WALLET_BALANCE`                               | `0.01`                       | balance that must remain after stake + gas reserve        |
| `MAX_GAS_PRICE_GWEI`                               | `5`                          | live only                                                 |
| `MIN_SECONDS_BEFORE_LOCK`                          | `6`                          | latest submission time                                    |
| `MAX_EXECUTION_FAILURES`                           | `3`                          | circuit breaker: pause + disarm                           |
| `CLAIM_BATCH_MIN`, `CLAIM_MAX_DELAY_MINUTES`       | `3`, `60`                    | claim batching                                            |
| `SIMULATED_GAS_PER_BET`, `SIMULATED_GAS_PER_CLAIM` | `0.00001`                    | paper & backtest gas assumptions                          |
| `POLL_INTERVAL_MS`                                 | `3000`                       | market snapshot interval                                  |
| `SYNC_BATCH_SIZE`, `SYNC_CONCURRENCY`              | `200`, `2`                   | history sync                                              |
| `WALLET_SYNC_INTERVAL_MS`, `RECONCILE_INTERVAL_MS` | `60000`, `600000`            |                                                           |
| `LOG_LEVEL`, `LOG_DIR`                             | `info`, `./logs`             | `LOG_DIR=none` disables files                             |

## Historical data

```bash
npm run app -- import-history                      # V2 archive from GitHub (~86 MB)
npm run app -- import-history --format v1          # retired V1 (block-based) archive
npm run app -- import-history --format prdt        # retired PRDT archive
npm run app -- import-history --file ./rounds.csv  # a local copy
npm run app -- sync-history                        # every epoch not yet final in the DB, from chain
```

Imports are repeatable: identical duplicate rows are collapsed, conflicting duplicates are excluded (and later
filled from chain), malformed rows are reported with line numbers, and CSV data never overwrites chain data. Each
run is recorded in `import_runs` and the audit log. The running server also syncs incrementally every 5 minutes and
reconciles every 10 minutes (stale rounds, a 2,000-epoch gap window, and a rolling 1,000-epoch verification sweep of
stored rounds against the contract).

## Wallet security

- The private key is read from the environment only. It is held on a non-enumerable config property and inside the
  viem local account; it is never written to the database, logs, API responses or the browser.
- Log lines are scrubbed of the key and the admin token before being written, in addition to field redaction.
- `.gitignore` excludes `.env*` (except the example), `data/`, `logs/`; `npm run check:secrets` fails on committed
  env files, PEM keys, hex keys assigned to key-like names, mnemonics, and a non-placeholder `.env.example`.
- Use a dedicated hot wallet funded only with the risk capital you intend to use. Consider `MIN_WALLET_BALANCE`
  and `MAX_TOTAL_EXPOSURE` as hard stops.
- The dashboard binds to localhost by default. To expose it, use a TLS reverse proxy; cookies become `Secure`
  automatically behind HTTPS.

## Risk controls (summary)

Global (environment, cannot be raised from the UI) → per strategy (can only tighten) → per trade checks → live gate:

`LIVE_TRADING_ENABLED ∧ armed in dashboard ∧ valid signer ∧ strategy enabled ∧ strategy live flag ∧ risk limits OK ∧
round open with time to spare ∧ sufficient balance ∧ bot RUNNING/READY ∧ circuit breaker clear`.

Just before signing, live execution re-checks fresh chain state: current epoch, seconds to lock, the wallet's
existing bet in the contract ledger, contract paused, minimum bet, gas price and balance.

## Recovery and failure behaviour

| Failure                         | Behaviour                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC down / timeouts             | fallback transport + retries; market marked stale after repeated failures (no trading), `RPC_UNAVAILABLE` audit; recovers automatically                               |
| Process crash / restart         | recovery runs before any trading: pending txs resolved from receipts/ledger, history synced, wallet bets imported, settlements applied; live disarmed                 |
| Broadcast outcome unknown       | trade stays SUBMITTING; reconciler resolves it (receipt → CONFIRMED/FAILED; after lock + buffer, ledger amount > 0 → CONFIRMED, else FAILED `DROPPED`). Never re-sent |
| Reverted bet                    | FAILED with the gas it burned recorded in P&L; counts toward the circuit breaker                                                                                      |
| Repeated execution failures     | circuit breaker pauses the bot and disarms live trading (`RISK_LIMIT_TRIGGERED`, CRITICAL)                                                                            |
| Strategy exception / bad config | recorded NO_TRADE with the error; other strategies continue                                                                                                           |
| Round not ended by the operator | becomes CANCELLED once past close + buffer (chain time); trades settle as REFUNDED                                                                                    |
| Data disagreement               | CSV-imported round replaced by chain data with the old values kept; chain-vs-chain conflicts are reported, never overwritten                                          |
| Interrupted backtest            | marked FAILED on restart                                                                                                                                              |

## Logs

JSON lines to stdout and `logs/{app,strategy,tx,audit,error}.log` (errors from every channel also in `error.log`).
The audit trail is in the database (`audit_events`, append-only) and on the **Logs** page.

## Deployment

- Docker: `docker compose up --build -d` (binds `127.0.0.1:8080`; mounts `./data` and `./logs`).
- Bare metal: `npm ci && npm run build && npm start` under a supervisor (systemd, pm2). Back up `data/*.db`
  (SQLite WAL: use `sqlite3 data/bsc-predict.db ".backup backup.db"` or stop the process first).
- Health: `GET /api/health` (unauthenticated) — `status: ok|degraded`.

## Troubleshooting

| Symptom                             | Cause / fix                                                                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration:` at startup | the listed variables are missing or invalid                                                                                                                                                                                            |
| `missing trie node` during sync     | a public node pruned the pinned block; the sync re-pins and retries automatically                                                                                                                                                      |
| Market "stale" badge                | RPC failing; check `RPC_URLS`, see `RPC_UNAVAILABLE` in Logs                                                                                                                                                                           |
| Bot RUNNING but nothing happens     | phase RECOVERING (see Logs), no strategy enabled, or the entry window has not started                                                                                                                                                  |
| Live decisions rejected             | the decision's risk checks list the failed gate (e.g. `LIVE_ARMED`)                                                                                                                                                                    |
| Nothing claimed                     | `LIVE_TRADING_ENABLED=false`, batching (`CLAIM_BATCH_MIN`), or already claimed outside the app                                                                                                                                         |
| `ExperimentalWarning: SQLite`       | harmless; `npm start` suppresses it                                                                                                                                                                                                    |
| Dashboard asks for an admin token   | enter the `ADMIN_API_TOKEN` value from `.env` (sessions last 12 h and reset on restart); for local development only, `node scripts/dev-dashboard.mjs` serves the dashboard on :5173 with the token added server-side by the Vite proxy |
