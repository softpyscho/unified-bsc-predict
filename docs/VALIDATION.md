# Validation record

Performed on 2026-09-13 (Windows 11, Node.js 24.21, SQLite 3.53 via `node:sqlite`). Nothing below spent real funds.

## Automated pipeline — `npm run validate` (exit 0)

| Step                                      | Result                                                 |
| ----------------------------------------- | ------------------------------------------------------ |
| Secret scan (`scripts/check-secrets.mjs`) | passed, 120 files                                      |
| Prettier check                            | all files formatted                                    |
| ESLint                                    | 0 problems                                             |
| TypeScript (core, server, web; strict)    | 0 errors                                               |
| Tests (Vitest)                            | **95 passed** (57 core, 38 server) in 8 files          |
| Build                                     | server bundled with esbuild; dashboard built with Vite |

### What the tests cover

- **Core math** — wei conversions (incl. a float-noise bug found and fixed: `bnbToWei(0.1)`), round status/finality,
  outcome, exact contract payouts verified against real V2 rounds 408633/408634 (reward = total − 3% fee, byte-exact),
  own-stake dilution, ties and cancellations.
- **Trade state machine** — legal/illegal transitions, guarded updates, append-only history.
- **Risk engine** — every rule, clamping, cooldown expiry, limit merging (can only tighten), external gates.
- **Decision pipeline** — strategy exceptions and invalid signals never trade; WAIT/entry-window; direction filter.
- **Look-ahead protection** — context contains only rounds known at decision time; cancellations only after
  close + buffer; live lock price only after lock; no pool/price in backtests; a backtest that would win 100% only
  if it could see round n−1 (and lose 100% if it leaked) wins exactly as expected.
- **Portfolio** — hand-computed ledger (wins/losses/refunds/failed gas/open): every money figure exact, streaks,
  drawdown (abs and %), profit factor, periods, determinism under input reordering.
- **Backtester** — exposure of the previous round while deciding the next, books balance (final bankroll = start +
  net P&L), incremental stepping, determinism.
- **Database integrity** — idempotent migrations and upserts, final-round immutability trigger, CSV→chain
  corrections with history, append-only audit and trade events, one live bet per wallet and round.
- **Config & secrets** — clear failures, live requires a key, key/address mismatch rejected, secrets not serializable,
  logger scrubs the key and token in every channel file.
- **Ingestion (simulated contract)** — initial sync, idempotent re-sync, incremental finalization, cancellation only
  from chain time after close + buffer, reconciliation correcting CSV data, stale-market detection and recovery.
- **CSV import** — real V2 rows, V1 and PRDT rows, malformed rows, identical vs conflicting duplicates, repeatability.
- **End-to-end paper cycle** — new round → ingestion → signal → risk approval → paper bet → settlement → payout →
  P&L → portfolio → API responses and SSE events (market/decision/trade/audit/bot); cancelled round refund; closed
  live gate recorded as the reason; broken strategy config isolated; emergency stop.
- **End-to-end live cycle (simulated PancakeSwap V2 contract)** — bet → receipt → settlement → batched claim with the
  identity _wallet balance change = Σ ledger net P&L_ (stakes, payouts, bet gas, claim gas); affordability check
  before submission; circuit breaker after repeated failures (pause + disarm); ambiguous broadcast resolved from the
  receipt with no re-send; crash with unknown broadcast → restart → no re-submission, dropped bet marked FAILED
  after lock, live disarmed; bets placed outside the app imported.
- **API** — auth required, HttpOnly/SameSite=Strict session, login rate limiting, cross-origin mutation rejection,
  validation errors, bot lifecycle + audit, exact confirmation phrase for arming, no secrets in any response,
  manual orders through the risk pipeline, SSE stream, backtest over stored rounds.

## Real BNB Smart Chain (mainnet, read-only)

| Check              | Result                                                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app health`       | contract params, head (block 121,654,530), pinned snapshot, oracle BNB/USD all OK                                                                                                                                                                                                                     |
| `app verify-chain` | every contract call used (params, head, pinned multicall rounds, ledger, getUserRounds(Length), claimable/refundable, balance, gas price) OK; `betBull` dry-run with value 0 → contract revert; with `minBetAmount` from an empty throwaway key → `INSUFFICIENT_FUNDS`. **No transaction broadcast.** |
| Oracle address     | the contract's `oracle()` returns `0x0567F232…aeE`; the original bot's hard-coded `0xD276…` is stale                                                                                                                                                                                                  |

## Historical data (real archives + chain)

| Step                                                     | Result                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| V2 archive import (86 MB, 423,246 rows)                  | 408,880 rounds inserted in 27 s; 14,365 identical duplicate rows collapsed; 1 malformed row (line 174,483: two rows fused) excluded; 0 conflicts |
| V1 archive (`data/main`)                                 | 20,541 rounds; re-importing the `data/v1/main` subset inserted 0 (idempotent)                                                                    |
| PRDT archive                                             | 28,312 rounds; 254 rows neither completed nor cancelled reported as incomplete (not guessed)                                                     |
| Chain sync of missing epochs                             | 102,542 epochs via Multicall in 18.6 min, 0 conflicts (first attempt hit `missing trie node` on a pruned public node → pin refresh added)        |
| Resulting V2 store                                       | epochs 1–515,426 with **0 gaps**; 408,880 archive + 106,546 chain rows; 884 ties, 261 cancelled                                                  |
| Reconciliation sweep (epochs 1–1,000 re-read from chain) | 1,000 unchanged, 0 corrected, 0 conflicts — archive matches the contract                                                                         |

## Real-data backtest (CLI)

`backtest --strategy follow-last-winner,momentum,streak-reversal --from 2021-08-26 --to 2026-09-13 --bankroll 10
--no-global-limits` — 499,689 real rounds, 3 strategies, 105 s:

| Strategy           | Trades  | Win rate | Net (0.001 BNB stakes) | ROI     | Notes                                                                                          |
| ------------------ | ------- | -------- | ---------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| follow-last-winner | 269,086 | 49.80%   | −9.999 BNB             | −3.72%  | bankroll exhausted (100% drawdown) ≈ Apr 2024; afterwards 229,716 rounds rejected by `MIN_BET` |
| momentum           | 63,895  | 49.19%   | −1.924 BNB             | −3.01%  |                                                                                                |
| streak-reversal    | 63,010  | 50.66%   | +10.277 BNB            | +16.31% | in-sample result of one of three strategies tried; not evidence of an edge                     |

## Running system on mainnet (paper mode)

- Server started with the real database; startup recovery completed; dashboard served; SSE live.
- Three strategies enabled and the bot started **through the dashboard UI**.
- Round **#515425**: all three strategies evaluated 29 s before lock and placed paper bets (follow-last-winner UP —
  following #515423, the last _completed_ round; momentum UP on 5 rising closes; streak-reversal DOWN fading 7 UP
  rounds). Each decision stored with inputs and all risk checks.
- #515425 closed UP ($718.74 → $719.28). It was held at CLOSING until the result was confirmed 3 blocks deep, then
  ENDED. The two UP paper trades settled WON with a payout of 0.002736395351331486 BNB each and the DOWN trade LOST;
  both payouts are identical to the wei to an independent recomputation of the contract formula (stake added to the
  final 0.619 / 1.129 BNB pools, 3% fee), and net P&L = payout − stake − simulated bet gas − simulated claim gas
  (+0.001716395351331486 / −0.00101 BNB). ROUND_SETTLED and TRADE_SETTLED audit events recorded.
- Restart while running with open trades: migration 2 applied, recovery completed, bot back to RUNNING/READY, a
  backtest owned by another process was left running (heartbeat) and finished. The restarted server then decided
  round **#515426** on schedule (three more paper bets; follow-last-winner now following #515424, streak-reversal
  fading an 8-round UP run) while the #515425 trades stayed open, untouched and never duplicated.
- Endpoint latency after the stats fix: all dashboard endpoints ≤ 0.16 s (most 2–5 ms).
- Dashboard pages checked with real data: Dashboard, Live, History, Round detail (incl. the chain-repaired #161514),
  Trades, Strategies, Bot, Backtest result, Settings.

## Not validated

- **Live transactions on mainnet** — deliberately not executed (no funded key was provided, and automated tests must
  not spend real funds). The live path is covered by the simulated-contract end-to-end tests and the real-chain
  dry-run (`verify-chain`); run `app health` and a minimal-stake live bet yourself before relying on it.
- **Docker** — Docker is not installed on the validation machine; `docker/Dockerfile` and `docker-compose.yml` were
  written but not built or run.
- **Screenshots** — the dashboard was verified through page text and the accessibility tree (the browser pane was not
  displayed for pixel screenshots), so visual layout was not inspected pixel-by-pixel.
- **Testnet** — supported by configuration (`CHAIN_ID=97`) but not exercised.
