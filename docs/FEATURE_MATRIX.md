# Source audit and feature matrix

All three repositories were cloned and read in full (not just their READMEs) on 2026-09-13.

## What each repository actually contained

### `bsc-prediction-market` (Next.js 12, React 17, Redux Toolkit, web3.js 1.x, web3-react) — 165 commits, last 2022-10

- Alternative PancakeSwap Prediction UI: rounds table (payouts, prize pool, lock/close price, live price via the
  Chainlink oracle), bet modal (browser wallet `betBull`/`betBear`), claim button, countdown, paused banner.
- Account **history**: `getUserRounds` paging for any address, enrichment into won/lost/claimable, "even money"
  view, max drawdown, biggest win.
- **Leaderboards**: fetched pre-computed CSVs from bsc-predict-updater (the code that generated them was in none of
  the repositories).
- CAKE **lottery** pages, a markdown **blog**, Mixpanel analytics, a guided tour.
- Round data came from three places at once: GitHub-hosted CSV archives, direct contract calls, and The Graph
  (`thegraph.com/.../prediction-v2`, since deprecated). Payout ratios hard-coded the 3% fee (`* 0.97`).

### `bsc-predict-bot` (Python, web3.py 5) — 4 commits, 2021-12

- `BaseBot.run()` loop: poll every 3 s, find the bettable round (start + 30 s buffer … lock), call the strategy's
  `get_bet(round)`, send `betBull`/`betBear`; claim every 300 s once ≥ 3 claimable rounds.
- Strategies: `SimpleBot` (follow the last winner), `TrendingBot` (5 oracle prints monotonic → follow trend).
- History bootstrap from the updater's CSV on GitHub; oracle history via `getRoundData`.
- Key in `.env`; `--dry` run; `--min` balance (parsed but never enforced); no persistence, no P&L, no retries,
  `epochs_bet` kept only in memory (a restart could bet again), exceptions swallowed, hard-coded oracle
  `0xD276…` — **stale**: the live contract's `oracle()` now returns `0x0567F232…aeE`.

### `bsc-predict-updater` (Python, web3.py 5) — 1 commit (history squashed by `update-git.sh`)

- `update_predict.py`: reads `rounds(epoch)` one call per epoch, appends to `data/v2/main/rounds.csv` when the round
  is ended or past `close + buffer`; same for PRDT (`rounds` + `timestamps`); `update_lottery.py` for the lottery.
- Data (≈ 100 MB): V2 423,246 rows; V1 (`data/main`, superset of `data/v1/main`); PRDT 28,566 rows; testnet samples;
  leaderboard and lottery CSVs.
- **Data-quality findings** (measured during import): V2 has 14,365 duplicate epoch rows (all identical), one
  corrupt line (line 174,483: row 161513 truncated and fused with row 161514, 22 columns), and stops at epoch
  408,882 (Aug 2025) — ~106k rounds behind the chain (epoch 515,4xx on 2026-09-13).
- All three repositories ship byte-identical copies of the V2 prediction ABI (md5 `07a4642c`).

## Feature matrix

| Existing feature                                     | Source           | Keep | Rewrite | Remove | Reason / where it lives now                                                                                                             |
| ---------------------------------------------------- | ---------------- | :--: | :-----: | :----: | --------------------------------------------------------------------------------------------------------------------------------------- |
| Rounds table (payouts, pool, lock/close, live price) | market           |      |    ✓    |        | Live Rounds + History pages; payouts computed from the contract's treasury fee, not a hard-coded 0.97                                   |
| Countdown / paused banner                            | market           |      |    ✓    |        | Top bar + round cards; chain-time based                                                                                                 |
| Manual bet modal (browser wallet)                    | market           |      |    ✓    |        | Manual order form → same risk + execution pipeline as the bot (server wallet); paper or live                                            |
| Claim button                                         | market           |      |    ✓    |        | Wallet page "Claim now" + automatic batched claims                                                                                      |
| Account history (`getUserRounds`)                    | market           |      |    ✓    |        | Wallet sync imports any wallet's on-chain bets into the ledger (IMPORTED); watch wallets                                                |
| Win/loss enrichment, drawdown, biggest win           | market           |      |    ✓    |        | Core portfolio analytics (exact wei)                                                                                                    |
| "Even money" view                                    | market           |      |         |   ✓    | Replaced by ROI/profit-factor metrics; low value                                                                                        |
| Leaderboards                                         | market + updater |      |         |   ✓    | Generator code was in no repository; the CSVs are a frozen 2025 snapshot; recomputing needs a full event indexer                        |
| CAKE lottery                                         | market + updater |      |         |   ✓    | Not a prediction market; out of scope                                                                                                   |
| Blog, SEO, sitemap, guided tour, Mixpanel            | market           |      |         |   ✓    | Marketing site content / third-party tracking; not part of an operator console                                                          |
| The Graph queries                                    | market           |      |         |   ✓    | Subgraph deprecated; chain + database are the single source                                                                             |
| GitHub-hosted CSV as live data source                | market + bot     |      |         |   ✓    | CSVs are imported once; the database is canonical                                                                                       |
| Testnet support                                      | market + updater |  ✓   |         |        | `CHAIN_ID=97` + `CONTRACT_ADDRESS`; testnet sample CSVs not imported (no value)                                                         |
| Contract ABIs                                        | all three        |  ✓   |         |        | `apps/server/src/chain/abis.ts` generated from the bot's JSON (identical in all repos), trimmed to used functions                       |
| Oracle reads                                         | bot + market     |      |    ✓    |        | Oracle address read from `oracle()` on the contract (the hard-coded one was stale)                                                      |
| Bot loop / lifecycle                                 | bot              |      |    ✓    |        | Worker + bot controller (start/stop/pause/resume/emergency), persisted state, recovery                                                  |
| Strategy abstraction `get_bet(round)`                | bot              |      |    ✓    |        | `StrategyPlugin.evaluate(ctx) → Signal` (BUY_UP / BUY_DOWN / WAIT / SKIP + confidence, rationale, indicators); strategies never execute |
| SimpleBot                                            | bot              |      |    ✓    |        | `follow-last-winner` (same semantics)                                                                                                   |
| TrendingBot                                          | bot              |      |    ✓    |        | `momentum` on round close prices (backtestable); flat series now skipped instead of BULL                                                |
| Bet sizing `--size`                                  | bot              |      |    ✓    |        | FIXED / BANKROLL_FRACTION / SIGNAL sizing + caps                                                                                        |
| `--min` balance                                      | bot              |      |    ✓    |        | `MIN_WALLET_BALANCE` risk rule (actually enforced now)                                                                                  |
| `--dry` run                                          | bot              |      |    ✓    |        | Paper trading (persisted, settled, analysed)                                                                                            |
| Transaction building/signing                         | bot              |      |    ✓    |        | viem; simulate → estimate → sign locally → persist hash → broadcast → receipt                                                           |
| Claiming                                             | bot              |      |    ✓    |        | Claim service: on-chain claimability check, batching, gas attribution, external-claim detection                                         |
| Private key from `.env`                              | bot              |  ✓   |         |        | Kept env-only; now non-enumerable in config, scrubbed from logs, never stored or returned                                               |
| Historical updater (per-epoch calls, CSV append)     | updater          |      |    ✓    |        | History sync: Multicall batches, confirmations, finality from chain time, idempotent upserts, reconciliation                            |
| Historical CSV data                                  | updater          |  ✓   |         |        | `import-history` (V2, V1, PRDT) with validation, duplicate/conflict/malformed reports                                                   |
| PRDT market                                          | updater          |  ✓   |         |        | Imported as a historical, non-tradable market; backtestable (bonuses not modelled)                                                      |
| V1 market                                            | updater          |  ✓   |         |        | Imported as historical (block-based, so not backtestable)                                                                               |
| `update-git.sh` force-push of data                   | updater          |      |         |   ✓    | Database replaces git-as-datastore                                                                                                      |
| `get-pip.py` vendored installer                      | updater          |      |         |   ✓    | Unrelated binary blob                                                                                                                   |

## What is new (not in any source repository)

Canonical database with integrity constraints; decisions persisted for every round ("why no bet"); risk engine and
live-trading gate; circuit breaker; restart recovery and transaction reconciliation; settlement with exact payouts;
portfolio analytics; backtesting with look-ahead protection; audit log; authentication; SSE real-time dashboard;
CLI; Docker; tests.
