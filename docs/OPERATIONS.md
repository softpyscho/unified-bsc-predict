# Operations

## Configuration

All settings come from the environment (`.env` is loaded automatically). The process validates everything at
startup and exits with a list of every problem. See `.env.example` for defaults.

| Variable                                           | Default                   | Notes                                                     |
| -------------------------------------------------- | ------------------------- | --------------------------------------------------------- |
| `ADMIN_API_TOKEN`                                  | — (required)              | ≥ 24 chars; dashboard login / Bearer token                |
| `HOST`, `PORT`                                     | `127.0.0.1`, `8080`       | a warning is logged when not bound to loopback            |
| `DATABASE_URL`                                     | `pglite:./data/pg`        | embedded Postgres dir, or `postgres://…` (see Database)   |
| `RPC_URL`, `RPC_URLS`                              | public BSC dataseeds      | fallback transport across all URLs                        |
| `LOG_RPC_URLS`                                     | `https://rpc-bsc.48.club` | eth_getLogs endpoints for pool events                     |
| `POOL_EVENTS_ENABLED`, `POOL_EVENTS_CHUNK_BLOCKS`  | `true`, `5000`            | per-bet pool event collector                              |
| `POOL_EVENTS_BACKFILL_BLOCKS`                      | `600000`                  | backfill depth below the first collected block (0 = none) |
| `CHAIN_ID`                                         | `56`                      | `97` for testnet                                          |
| `CONTRACT_ADDRESS`                                 | V2 `0x18B2…9cdA`          | the tradable prediction contract                          |
| `CONFIRMATIONS`                                    | `3`                       | depth used before a round is treated as final             |
| `PRIVATE_KEY`                                      | empty                     | signing key (live only); never stored, logged or returned |
| `WALLET_ADDRESS`                                   | empty                     | watch-only, or a consistency check against the key        |
| `LIVE_TRADING_ENABLED`                             | `false`                   | master switch for any transaction                         |
| `PAPER_TRADING_ENABLED`                            | `true`                    |                                                           |
| `PAPER_STARTING_BANKROLL`                          | `1`                       | BNB                                                       |
| `BOT_AUTO_RESUME_LIVE`                             | `false`                   | keep live armed across restarts                           |
| `DEFAULT_BET_SIZE`                                 | `0.001`                   | default fixed stake for seeded strategies                 |
| `MAX_BET_SIZE`                                     | `0.01`                    | per-trade cap                                             |
| `MAX_BANKROLL_FRACTION`                            | `0.05`                    | per-trade cap as a fraction of bankroll                   |
| `MAX_DAILY_LOSS`                                   | `0.05`                    | realized net loss per UTC day (per mode)                  |
| `MAX_CONSECUTIVE_LOSSES`, `COOLDOWN_ROUNDS`        | `5`, `12`                 | loss-streak cooldown                                      |
| `MAX_TOTAL_EXPOSURE`                               | `0.05`                    | stake in unsettled trades                                 |
| `MIN_WALLET_BALANCE`                               | `0.01`                    | balance that must remain after stake + gas reserve        |
| `MAX_GAS_PRICE_GWEI`                               | `5`                       | live only                                                 |
| `MIN_SECONDS_BEFORE_LOCK`                          | `6`                       | latest submission time                                    |
| `MAX_EXECUTION_FAILURES`                           | `3`                       | circuit breaker: pause + disarm                           |
| `CLAIM_BATCH_MIN`, `CLAIM_MAX_DELAY_MINUTES`       | `3`, `60`                 | claim batching                                            |
| `SIMULATED_GAS_PER_BET`, `SIMULATED_GAS_PER_CLAIM` | `0.00001`                 | paper & backtest gas assumptions                          |
| `POLL_INTERVAL_MS`                                 | `3000`                    | market snapshot interval                                  |
| `SYNC_BATCH_SIZE`, `SYNC_CONCURRENCY`              | `200`, `2`                | history sync                                              |
| `WALLET_SYNC_INTERVAL_MS`, `RECONCILE_INTERVAL_MS` | `60000`, `600000`         |                                                           |
| `LOG_LEVEL`, `LOG_DIR`                             | `info`, `./logs`          | `LOG_DIR=none` disables files                             |

## Database

The store is PostgreSQL. The same migrations run against every backend:

| `DATABASE_URL`                                      | Backend                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `pglite:./data/pg` (default)                        | embedded Postgres (PGlite, WASM) in a local directory; nothing to install |
| `postgres://user:pass@host:5432/db`                 | any Postgres: Docker Compose's `db` service, a VPS, Supabase              |
| `postgresql://…@db.<ref>.supabase.co:5432/postgres` | Supabase (use the direct or session-pooler URL; set `?sslmode=require`)   |
| `memory:`                                           | in-memory PGlite (tests)                                                  |

Migrations run at startup inside one transaction under an advisory lock, so two processes starting together cannot
both apply them. Money is `NUMERIC(78,0)` wei, append-only tables and final-round immutability are enforced by
PL/pgSQL triggers, and at most one non-failed bet per wallet and round is a partial unique index.

Embedded PGlite is single-process: the server holds `data/pg.lock` while it runs, and a second process (such as the
CLI) refuses to open the same directory instead of corrupting it. Stop the server before CLI commands that touch the
database, use the dashboard, or switch to a `postgres://` URL, which any number of processes can share. A lock left
by a crashed process is taken over automatically.

**Moving from the old SQLite file.** Earlier versions stored everything in `data/bsc-predict.db`; the app now refuses
a `file:` URL at startup. Import it once, then switch the URL:

```bash
npm run build
DATABASE_URL=pglite:./data/pg npm run app -- import-sqlite data/bsc-predict.db   # or a postgres:// URL
# then set DATABASE_URL=pglite:./data/pg (or the postgres:// URL) in .env and restart
```

The import keeps every row id (so references in logs and reports stay valid), restores the bot state, advances the
identity sequences, and refuses to write into a database that already has data. The SQLite file is left untouched.

## Pool events (research data)

Round totals say how much was bet; they do not say when. The worker's `pool-events` loop (every 15 s) stores every
`BetBull`/`BetBear` log in `round_pool_events` (sender, side, amount, block, block time, tx, log index), so research
can reconstruct each round's pool as it stood at any decision time (`poolBefore`: blocks strictly before the decision
second). A round's events are trusted only when they sum to the round's final bull and bear amounts exactly, in wei.

- Forward collection follows the head minus `CONFIRMATIONS`. Three consecutive failures on the same range record it
  in `pool_event_gaps` (audit `POOL_EVENTS_GAP`) and move on; rounds inside a gap fail the completeness check.
- Backfill works down from the first collected block, 4 chunks per run, to `POOL_EVENTS_BACKFILL_BLOCKS` deep. It
  stops for good after three failures in a row (audit `POOL_EVENTS_BACKFILL_STOPPED`), which is what a pruning node
  looks like. `pool-events reset-backfill` retries, e.g. after pointing `LOG_RPC_URLS` at a node with more history.
- Only BNB Chain nodes that serve `eth_getLogs` work: the default dataseeds reject it. 48.club returns block
  timestamps with each log and keeps a few days; any other node's timestamps are read from block headers.
- Volume is roughly 100–300 events per round (tens of thousands of rows a day). That is fine for PGlite or a VPS
  Postgres, but it fills Supabase's free 500 MB tier in about two months.

```bash
npm run app -- pool-events status          # collected range, gaps, exact-reconstruction check of the last 288 final rounds
npm run app -- pool-events sync            # collect and backfill until caught up (server stopped, when using PGlite)
npm run app -- pool-events reset-backfill
```

`GET /api/pool-events` returns the same status, and `GET /api/rounds/:epoch` includes the round's events.

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

- Docker: set `POSTGRES_PASSWORD` in `.env`, then `docker compose up --build -d` (app on `127.0.0.1:8080` backed
  by the unpublished `db` Postgres service; data in `./data/postgres`, logs in `./logs`).
- Bare metal: `npm ci && npm run build && npm start` under a supervisor (systemd, pm2). Back up with
  `pg_dump "$DATABASE_URL" > backup.sql` for a server database; for the embedded default, stop the process and copy
  `data/pg`.
- The worker (trading loop) must run on a long-lived host (local machine or VPS). It can share one Supabase
  database with a dashboard deployed elsewhere. Never run it from GitHub Actions, and keep `PRIVATE_KEY` only in
  the worker's environment.
- Health: `GET /api/health` (unauthenticated) — `status: ok|degraded`.

## Troubleshooting

| Symptom                                | Cause / fix                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration:` at startup    | the listed variables are missing or invalid                                                                                                                                                                                            |
| `missing trie node` during sync        | a public node pruned the pinned block; the sync re-pins and retries automatically                                                                                                                                                      |
| Market "stale" badge                   | RPC failing; check `RPC_URLS`, see `RPC_UNAVAILABLE` in Logs                                                                                                                                                                           |
| Bot RUNNING but nothing happens        | phase RECOVERING (see Logs), no strategy enabled, or the entry window has not started                                                                                                                                                  |
| Live decisions rejected                | the decision's risk checks list the failed gate (e.g. `LIVE_ARMED`)                                                                                                                                                                    |
| Nothing claimed                        | `LIVE_TRADING_ENABLED=false`, batching (`CLAIM_BATCH_MIN`), or already claimed outside the app                                                                                                                                         |
| `DATABASE_URL points to a SQLite file` | run the one-time `import-sqlite` (see Database) and point `DATABASE_URL` at `pglite:./data/pg` or a `postgres://` URL                                                                                                                  |
| Dashboard asks for an admin token      | enter the `ADMIN_API_TOKEN` value from `.env` (sessions last 12 h and reset on restart); for local development only, `node scripts/dev-dashboard.mjs` serves the dashboard on :5173 with the token added server-side by the Vite proxy |
