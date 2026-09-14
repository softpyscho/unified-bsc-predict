# Unified BSC Predict

A single, production-oriented platform for the PancakeSwap BNB/USD Prediction market on BNB Smart Chain.
It unifies the three `bsc-predict` repositories — the alternative UI (`bsc-prediction-market`), the betting
bot (`bsc-predict-bot`) and the historical round archiver (`bsc-predict-updater`) — into one TypeScript
modular monolith with one canonical database and one auditable lifecycle:

```
INGEST → STORE → TRACK → ANALYZE → STRATEGIZE → RISK-CHECK → SIMULATE / EXECUTE → SETTLE → RECORD → ANALYZE PERFORMANCE
```

**Paper trading is the default. Live trading is off** unless the environment enables it, an operator arms it
in the dashboard with a typed confirmation, and the individual strategy opts in.

> The built-in strategies are demonstrations (two are ports of the original bot's strategies, whose README
> warned they lose money). Prediction markets are negative-sum after the 3% treasury fee. Nothing here is
> financial advice.

## What it does

| Area            | Capability                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical data | Imports the bsc-predict-updater CSV archives (V2, V1, PRDT) with validation, de-duplication and reports; syncs every missing epoch from chain via Multicall3; reconciles and corrects data against the contract (corrections are preserved). |
| Live tracking   | Expired / live / next / later rounds, pools, payouts, oracle price and countdowns, pushed to the dashboard over SSE.                                                                                                                         |
| Strategies      | Plugin interface (`evaluate(context) → Signal`); config edited at runtime; per-strategy limits; look-ahead-safe context.                                                                                                                     |
| Risk            | Global hard limits (environment) + strategy limits (can only tighten); 13 checks + the multi-condition live gate, all recorded per decision.                                                                                                 |
| Execution       | Paper fills or live transactions: fresh pre-flight chain checks, local signing, tx hash persisted before broadcast, receipts, classified errors, circuit breaker, never blind re-submission.                                                 |
| Settlement      | Exact contract payout formula (live) / own-stake-diluted payout (paper); claims batched and verified on-chain; external bets and claims detected.                                                                                            |
| Analytics       | Portfolio P&L, ROI, win/loss, profit factor, streaks, drawdown, daily/weekly/monthly, per strategy/market/direction, distributions — exact bigint wei arithmetic.                                                                            |
| Backtesting     | Replays stored rounds through the same decision pipeline with simulated execution; strategy comparison.                                                                                                                                      |
| Operations      | Bot start/stop/pause/resume/emergency-stop, restart recovery, append-only audit log, structured log channels, CLI.                                                                                                                           |

## Quick start (local)

Requirements: Node.js ≥ 22.13 (Node 24 recommended). The database is PostgreSQL: by default an embedded PGlite
directory (`data/pg`, nothing to install); set `DATABASE_URL=postgres://…` for a server or Supabase
(see [docs/OPERATIONS.md](docs/OPERATIONS.md#database)).

```bash
npm ci
cp .env.example .env            # then set ADMIN_API_TOKEN (openssl rand -hex 32)
npm run build
npm run migrate
npm run migrate:history         # optional: import the V2 archive (~86 MB download) — see docs/OPERATIONS.md
npm run app -- sync-history     # fill every epoch missing from the archive, from chain
npm start                       # http://127.0.0.1:8080 — sign in with ADMIN_API_TOKEN
```

Development (hot reload): `npm run dev:server` and `npm run dev:web` (dashboard on :5173, proxied to :8080).

### Docker

```bash
cp .env.example .env            # set ADMIN_API_TOKEN and POSTGRES_PASSWORD
docker compose up --build       # dashboard on http://127.0.0.1:8080 ; Postgres data in ./data/postgres, logs in ./logs
```

## Paper trading

1. Open **Strategies**, enable a strategy (its _Paper_ flag is on by default).
2. Open **Bot** and press **Start**.
3. Watch **Live Rounds** (signals per round), **Trades** and **Portfolio**. Every round records why each strategy
   did or did not bet (Round detail → “Why did the bot bet or not bet?”).

CLI equivalent: `npm run app -- strategy enable follow-last-winner` then `npm run app -- bot start` (reaches a running server only with a `postgres://` `DATABASE_URL`; the embedded default allows one process at a time, so use the dashboard while the server runs).

## Enabling live trading (real funds)

1. Use a dedicated hot wallet holding only what you can afford to lose.
2. In `.env`: `PRIVATE_KEY=0x…`, `LIVE_TRADING_ENABLED=true`, and review every global limit (`MAX_BET_SIZE`,
   `MAX_DAILY_LOSS`, `MAX_TOTAL_EXPOSURE`, `MIN_WALLET_BALANCE`, `MAX_GAS_PRICE_GWEI`, …). Restart.
3. `npm run app -- health` — confirms RPC, contract, and the signer's balance.
4. Dashboard → **Strategies**: enable the strategy's **Live** flag.
5. Dashboard → **Bot**: **Start**, then **Arm live trading…** and type `ENABLE LIVE TRADING`.

Arming is cleared on every restart unless `BOT_AUTO_RESUME_LIVE=true`. **Emergency stop** blocks all new executions immediately.

## CLI

```bash
npm run app -- migrate                       # schema + seed markets/strategies/wallet
npm run app -- import-sqlite <file>          # one-time move of a pre-Postgres data/bsc-predict.db
npm run app -- import-history [--format v2|v1|prdt] [--file path | --url url] [--all]
npm run app -- sync-history [--from epoch]   # initial / catch-up sync from chain
npm run app -- sync-current                  # incremental sync
npm run app -- reconcile                     # repair + verify stored rounds, pending txs, settlements
npm run app -- bot status|start|stop|pause|resume|emergency-stop|reset --yes
npm run app -- strategy list|enable <slug> [--live]|disable <slug>
npm run app -- backtest --strategy follow-last-winner,momentum --from 2026-08-01 --to 2026-09-01 [--bankroll 1]
npm run app -- wallet add <address> | wallet sync
npm run app -- health
npm run app -- verify-chain                  # read-only check of every contract call + dry-run bet (never broadcasts)
```

## Validation

```bash
npm run validate   # secret scan, prettier, eslint, typecheck, unit/integration/e2e tests, build
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, data flow, database schema, state machines
- [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md) — audit of the three source repositories; what was kept, rewritten, removed
- [docs/STRATEGIES.md](docs/STRATEGIES.md) — strategy interface, writing plugins, paper/live/backtest parity
- [docs/API.md](docs/API.md) — HTTP API and SSE stream
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — configuration, security, risk controls, recovery, troubleshooting, deployment
- [docs/VALIDATION.md](docs/VALIDATION.md) — what was tested and how, including real-chain checks
