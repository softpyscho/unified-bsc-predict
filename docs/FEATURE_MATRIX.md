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

## Phase 1 re-audit (2026-09-15)

Re-cloned and re-read at bsc-prediction-market `148bb3d` (2022-10-02), bsc-predict-bot `6556cee` (2021-12-12) and
bsc-predict-updater `c1cf1e7` (2025-08-31). Every source file was read; blog posts and lottery pages were skimmed.
This section adds to, and in places corrects, the 2026-09-13 summary above. Paths are relative to each repository.

### Migration matrix

| Functionality                         | Source repo                 | Preserve | Rewrite | Drop | Rationale                                                                                                                                                                        |
| ------------------------------------- | --------------------------- | :------: | :-----: | :--: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market UI                             | prediction-market           |          |    ✓    |      | Concepts kept (rounds table, countdown, bet modal, claim, history). The Next 12 / React 17 / web3.js 1.x code, hard-coded 3% fee and dead data sources are not worth porting.    |
| Historical updater                    | updater                     |          |    ✓    |      | One RPC call per epoch, non-atomic CSV appends, git as the datastore → Multicall sync, idempotent upserts, reconciliation.                                                       |
| Historical data (CSV)                 | updater                     |    ✓     |         |      | Imported once with duplicate and corruption checks; 400/400 spot-checked rounds match chain (Phase 0).                                                                           |
| Round model                           | updater / bot               |          |    ✓    |      | Floats for wei and string-parsed booleans → exact bigint model in `packages/core/src/round.ts`.                                                                                  |
| Web3 layer                            | bot / updater               |          |    ✓    |      | One hard-coded RPC, no retry, fallback or Multicall → viem fallback transport + Multicall3.                                                                                      |
| Bet execution                         | bot                         |          |    ✓    |      | Fire-and-forget, success logged on submission, `latest` nonce → simulate / estimate / sign / persist / broadcast / receipt, one bet per (wallet, epoch).                         |
| Claim logic                           | bot                         |          |    ✓    |      | Claims winners only, never refunds, re-downloads the whole CSV each attempt → contract claimability check including refunds (`apps/server/src/services/claims.ts:50`), batching. |
| Strategy framework                    | bot                         |          |    ✓    |      | `get_bet(round)` with wall-clock timing inside each strategy → pure `StrategyPlugin` signals; timing owned by the engine.                                                        |
| Existing APIs                         | prediction-market           |          |         |  ✓   | `api/index.ts` only loads blog posts. The data "API" is GitHub CSVs (frozen Aug 2025) and The Graph's retired hosted service.                                                    |
| Leaderboards, lottery, blog, Mixpanel | prediction-market / updater |          |         |  ✓   | Out of scope (see the feature matrix above).                                                                                                                                     |

### Bugs

bsc-predict-bot

- `strategies/BaseBot.py:76-88` — `sleep()` sits inside `if bettable_round:`, so outside the betting window the loop
  re-reads rounds and oracle prints continuously with no pause.
- `strategies/BaseBot.py:54-55` — bets only from `startTimestamp + 30` (the close buffer used as a start delay) and
  allows `now == lockTimestamp`, where the contract reverts. Timing uses the local clock, not chain time.
- `strategies/BaseBot.py:81-85` — the epoch is marked as bet before sending; "Bet success" is logged on submission and
  the receipt is never checked.
- `strategies/BaseBot.py:73,87` — `logging.error("…", e)` passes the exception as a format argument, so its text is
  lost.
- `main.py:26-33,50` — `--min` balance is parsed and stored but never enforced (`strategies/utils.py`'s balance helper
  is unused).
- `contracts/prediction.py:93` — only rounds the bet side won are claimed; cancelled-round refunds are never claimed.
- `contracts/prediction.py:77` — every claim attempt (every 300 s) calls `get_history()`, re-downloading the full
  ~100 MB CSV and then fetching each missing epoch with its own call.
- `contracts/prediction.py:61,103` — nonce from `getTransactionCount` (latest, not pending), so a bet and a claim in
  flight together collide.
- `config.py:14` — oracle `0xD276…` is stale; the contract's `oracle()` returns `0x0567F232…aeE`, so `TrendingBot`
  reads a feed the contract no longer settles on.
- `contracts/oracle.py:18-31` — walks Chainlink round ids one call at a time assuming they are contiguous; a proxy
  phase change breaks it.

bsc-predict-updater

- `update_predict.py:1` — unused `from distutils…` import; `distutils` was removed in Python 3.12, so the script no
  longer starts on current Python.
- `update_predict.py:112` — PRDT rows are written once `r < cur - 1` whether or not the round is final, and never
  revisited.
- `update_predict.py:100,149` — plain appends with no lock or atomic write, consistent with the 14,365 duplicate rows
  and the truncated, fused row found at import.
- `update_predict.py:134` — `bufferSeconds` hard-coded to 30 behind a "why does this fail?" TODO, although the shipped
  ABI does contain `bufferSeconds`.
- `update-git.sh:1-13` — deletes `.git`, re-initialises and force-pushes on every run.

bsc-prediction-market

- `src/utils/bets.ts:31-35` — a cancelled-round refund is booked as profit equal to the stake in history and drawdown;
  `:51-53` bets on unknown rounds count as break-even.
- `src/contracts/prediction.ts:144-145`, `src/thunks/round.ts:95`, `src/thunks/bet.ts:104`,
  `src/stores/gameSlice.ts:28` — payout multipliers hard-code the 3% fee; `src/thunks/game.ts:18-24` reads
  `treasuryFee()` from the contract, but nothing uses the result.
- `src/contracts/prediction.ts:109-139` — `fetchUserRounds` swallows errors and returns partial history after one
  failure.
- `src/contracts/oracle.ts:2` — same stale oracle address as the bot.

### Duplicated logic

- The Prediction V2 ABI is copied into all three repositories (byte-identical, md5 `07a4642c`).
- Round-tuple parsing exists four times (bot `RoundClass`, updater raw rows, market `toRound`, market GraphQL mappers);
  payout maths five times (four in the market, plus the bot's claimability check).
- The market alone reads round history from three sources: GitHub CSVs, direct contract calls and The Graph.
- Web3 and contract construction is repeated per call site (`web3_provider.py`, `get_web3`, `web3Provider`,
  `getPredictionContract`, `BnbUsdt.fetchRounds`).

### Obsolete code and dependencies

- The Graph hosted-service endpoint (`src/constants.ts:45`) and the GitHub CSV pipeline (`src/constants.ts:23-43`,
  `config.py:12`): both dead.
- 2021-era pins (web3.py 5.21, aiohttp 3.7.4 in `requirements.txt`); Next 12, React 17, web3.js 1.x; `distutils`.
- Lottery, blog, leaderboards, Mixpanel, `get-pip.py`, `update-git.sh`, unused `deque` reads in
  `update_predict.py:118-119,167-168`.

### Unsafe assumptions

- The treasury fee is a constant 3% (market); `bufferSeconds` is a constant 30 (bot, updater).
- The oracle address never changes (bot, market).
- A sent transaction is a successful one, and the latest nonce is safe to reuse (bot).
- The local clock equals chain time (bot betting window).
- Wei amounts fit in floats (`RoundClass.py`, `Number(...)` throughout the market — exact only below ~0.009 BNB).
- GitHub-hosted CSVs are current (market, bot).
- Chainlink round ids are contiguous (bot).
- The market labels the pair "BNB/USDT" and prices balances from Binance spot (`src/constants.ts:19`), while rounds
  settle on the Chainlink BNB/USD feed.

Not a problem: the `.env` committed to bsc-prediction-market holds only public RPC URLs and the site URL.

### Status in this repository

The current codebase already implements every rewrite target above. I spot-checked the areas these bugs touch: the fee,
buffer and oracle are read from the contract, amounts are bigint wei, claims include refunds (`claims.ts:50`) and the
betting window runs on chain time. What the new brief adds — Postgres/Supabase, a Next.js dashboard, a separate worker,
`round_pool_events` and `research_experiments` — is new work, not migration from these repositories.
