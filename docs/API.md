# HTTP API

Base: `http://127.0.0.1:8080`. JSON everywhere; **wei amounts are decimal strings**; chain times are unix seconds,
application times (`placedAt`, `decidedAt`, audit `ts`) are unix milliseconds. Query parameters are validated
(zod); invalid input returns `400 { error, issues[] }`.

## Authentication

- `POST /api/auth/login {token}` → sets an HttpOnly, SameSite=Strict session cookie (12 h). Rate limited: 10 failed
  attempts per 5 minutes per address → `429`.
- Scripts may send `Authorization: Bearer <ADMIN_API_TOKEN>` instead.
- Every `/api/*` route except `/api/health` and `/api/auth/login` requires authentication. Mutations with an
  `Origin` header from another host are rejected (`403`).
- `POST /api/auth/logout`, `GET /api/auth/me`.

## System

| Method | Path            | Description                                                                                         |
| ------ | --------------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`   | unauthenticated; database, chain snapshot age, bot status/phase                                     |
| GET    | `/api/overview` | dashboard aggregate: market, bot, paper & live summaries, latest trades/decisions, alerts           |
| GET    | `/api/settings` | public configuration (no secrets), DB stats, import runs, sync state, plugins                       |
| POST   | `/api/sync`     | `{action: "incremental" \| "reconcile"}`                                                            |
| GET    | `/api/stream`   | Server-Sent Events: `hello`, `market`, `bot`, `trade`, `decision`, `audit`, `backtest`, `portfolio` |

## Markets and rounds

| Method | Path                  | Description                                                                                |
| ------ | --------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/api/markets`        | markets with round statistics                                                              |
| GET    | `/api/markets/:id`    | one market + sync state                                                                    |
| GET    | `/api/rounds`         | `marketId, fromEpoch, toEpoch, from, to, outcome, status, finalOnly, order, limit, offset` |
| GET    | `/api/rounds/current` | latest market snapshot (next / live / expired / later rounds, oracle, params)              |
| GET    | `/api/rounds/:epoch`  | `?marketId`; round + every strategy decision + trades + corrections + audit events         |

## Trades and decisions

| Method | Path                 | Description                                                                                                                                                                                                                           |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/trades`        | `mode, source, strategyId, walletId, marketId, direction, status, result, epoch, from, to (ms), minAmount, maxAmount (BNB), order, limit, offset` → rows (with running cumulative P&L / bankroll when filtered to one mode) + summary |
| GET    | `/api/trades/:id`    | trade + state history + decision + round                                                                                                                                                                                              |
| POST   | `/api/trades/manual` | `{mode: "PAPER"\|"LIVE", direction: "BULL"\|"BEAR", amountBnb}` — goes through the full risk pipeline                                                                                                                                 |
| GET    | `/api/decisions`     | `strategyId, mode, decision, epoch, limit, offset`                                                                                                                                                                                    |

## Portfolio

| Method | Path                       | Description                                                                                                                           |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/portfolio`           | `mode=PAPER\|LIVE\|ALL, walletId, strategyId, from, to` → account + full report (summary, breakdowns, periods, equity, distributions) |
| GET    | `/api/portfolio/snapshots` | `mode, since`                                                                                                                         |

## Strategies

| Method | Path                              | Description                                                                                            |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/strategies`                 | all strategies with plugin spec and paper/live performance                                             |
| GET    | `/api/strategies/:id`             | + recent decisions                                                                                     |
| GET    | `/api/strategies/:id/performance` | full PAPER and LIVE reports                                                                            |
| PATCH  | `/api/strategies/:id`             | `{enabled?, paperTradingEnabled?, liveTradingEnabled?, config?}` (config validated against the plugin) |

## Bot

| Method | Path                                        | Body                                                                                      |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/api/bot/status`                           | status, phase, gate inputs, next round, last decision/trade, open live txs, recent errors |
| POST   | `/api/bot/start` `/stop` `/pause` `/resume` | `{reason?}`                                                                               |
| POST   | `/api/bot/emergency-stop`                   | `{reason?}`                                                                               |
| POST   | `/api/bot/reset`                            | `{acknowledge: true}`                                                                     |
| POST   | `/api/bot/live/arm`                         | `{confirmation: "ENABLE LIVE TRADING"}`                                                   |
| POST   | `/api/bot/live/disarm`                      | `{reason?}`                                                                               |

## Backtesting

| Method | Path                | Description                                                                                                                                                                    |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/backtest`     | `{from, to (unix s), marketId?, startingBankrollBnb, gasPerBetBnb?, gasPerClaimBnb?, applyGlobalLimits, strategies: [{strategyId? \| plugin?, label?, config?}]}` → `202 {id}` |
| GET    | `/api/backtest`     | recent runs                                                                                                                                                                    |
| GET    | `/api/backtest/:id` | status, progress, result                                                                                                                                                       |

## Wallets, claims, logs

| Method | Path                    | Description                                                                            |
| ------ | ----------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/api/wallet`           | signer, live balance, live/paper accounts, unclaimed trades, claims                    |
| GET    | `/api/wallets`          | registered wallets                                                                     |
| POST   | `/api/wallets`          | `{address, label}` add a watch-only wallet                                             |
| POST   | `/api/wallets/:id/sync` | import that wallet's on-chain bets                                                     |
| GET    | `/api/claims`           | claim transactions                                                                     |
| POST   | `/api/claims`           | claim all claimable rounds now (requires `LIVE_TRADING_ENABLED` and a signer)          |
| GET    | `/api/logs`             | audit events: `type, severity, component, epoch, strategyId, tradeId, beforeId, limit` |
