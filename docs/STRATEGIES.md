# Strategies

## Interface

```ts
interface StrategyPlugin<P> {
  id: string;
  name: string;
  version: string;
  description: string;
  params: ParamSpec[]; // drives validation and the dashboard form
  defaults: P;
  lookback(params: P): number; // how many final rounds of history to receive
  evaluate(ctx: StrategyContext, params: P): Signal; // pure: no I/O, no side effects
}

interface Signal {
  action: 'BUY_UP' | 'BUY_DOWN' | 'WAIT' | 'SKIP';
  confidence: number; // estimated win probability 0..1 (min-confidence and edge checks)
  stakeBnb?: number; // used only when sizing mode is SIGNAL
  rationale: string;
  riskScore?: number;
  indicators?: Record<string, IndicatorValue>; // JSON-serializable; nested objects/arrays allowed
}
```

Strategies **never** place transactions. The engine turns the signal into a Decision through sizing and the risk
engine, and hands approved decisions to the execution adapter of the current mode.

## What a strategy can see (`StrategyContext`)

| Field          | Meaning                                                       |       Backtest       | Paper / Live |
| -------------- | ------------------------------------------------------------- | :------------------: | :----------: |
| `now`          | decision time (chain time)                                    | lock − entry seconds |  chain time  |
| `betting`      | the open round: epoch, start, lock, seconds to lock           |          ✓           |      ✓       |
| `betting.pool` | current UP/DOWN pool and implied payouts                      |       **null**       |      ✓       |
| `live`         | the locked round (epoch − 1) and its lock price               |          ✓           |      ✓       |
| `history`      | final rounds whose result was known at `now`, oldest → newest |          ✓           |      ✓       |
| `ownTrades`    | this strategy's own past trades, most recent first (≤ 20)     |          ✓           |      ✓       |
| `price`        | latest Chainlink BNB/USD                                      |       **null**       |      ✓       |
| `bankrollBnb`  | bankroll used for sizing                                      |      simulated       |   account    |

`buildContext` enforces the visibility rules: an ended round is visible once `closeTime ≤ now`, a cancelled
round only once `closeTime + buffer ≤ now`, the live round's lock price only after its lock time, and the betting
round's pool is never available in backtests (it is only final at lock). A strategy that relies on `pool` or `price`
therefore behaves differently in backtests — most built-ins only use `history`, so their backtests are faithful.

Because rounds overlap (round _i_ closes exactly when round _i_+1 locks), a round only enters `history` once the
round _two_ epochs later is being decided — the round in between is always still "live" (locked, not yet closed).
A strategy reacting to round _i_'s outcome therefore earliest reacts at round _i_+2, not _i_+1; this is a real
constraint of the market (a trade can't settle before its round closes, and a round can't close before betting on
the next-but-one round has opened), not an artifact of the context builder. Test fixtures can construct
`ownTrades` states that don't actually correspond to any reachable `history`, which is convenient for isolating a
strategy's ladder/confirmation logic in a unit test, but production always keeps the two consistent.

## Built-in plugins

| Plugin               | Origin                        | Logic                                                                                                                        |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `follow-last-winner` | bsc-predict-bot `SimpleBot`   | bet the winner of the latest completed round (skip ties); `invert` fades it                                                  |
| `momentum`           | bsc-predict-bot `TrendingBot` | last N round close prices never step against a direction → bet it; min move %                                                |
| `streak-reversal`    | new                           | after a run of N identical outcomes, FADE (bet against) or FOLLOW                                                            |
| `persistence`        | new                           | measures P(next = same \| last N identical) from history; bets only above a sample-size and edge threshold                   |
| `reversal`           | new                           | right after a run of ≥N breaks, measures P(new direction continues) vs P(it snaps back)                                      |
| `alternation`        | new                           | after an A,B,A,B,... run of ≥N, measures P(it continues) or P(a just-broken alternation runs further)                        |
| `transition-matrix`  | new                           | builds the empirical 1st/2nd-order transition matrix and bets the higher-probability side; matrix exposed for the dashboard  |
| `markov`             | new                           | order-N conditioning on the exact trailing N-outcome context (not just uniform runs); compare N by running several instances |
| `sequence-recovery`  | new                           | configurable recovery ladder — see [Sequence recovery ladder](#sequence-recovery-ladder) below                               |
| `ensemble`           | new                           | combines persistence/reversal/streak/transition/market-edge signals with configurable weights into one score                 |
| `manual`             | dashboard bet modal           | operator orders; same sizing/risk/execution path                                                                             |

All `new` plugins above live in `packages/core/src/strategy/sequenceStrategies.ts` and share `packages/core/src/sequence.ts`
for their probability estimates — see [Sequence analytics](#sequence-analytics) below. Every probability they report
(`pSame`, `pContinue`, transition-matrix cells, etc.) is measured fresh from `ctx.history` on each call and always
carries a `sampleSize`; none of it is hard-coded.

## Sequence analytics

`packages/core/src/sequence.ts` is the shared, pure analytics layer every plugin above is built from. It never
assumes a pattern is real — it measures it:

- `toSequence(history)` — the trailing directions with ties/cancellations dropped (they don't inform UP/DOWN
  persistence questions).
- `currentStreak(seq)` / `lastTransition(seq)` — the trailing run and the run it broke from.
- `persistenceEstimate(seq, n)` — P(next = same | last n identical), with sample size.
- `streakContinuationEstimate(seq, n)` — the same question phrased for "the current n-run", used by the
  streak/reversal-confirmation plugins.
- `alternationLength(seq)` / `alternationContinuationEstimate(seq, minLength)` — how long the trailing A,B,A,B,...
  run is, and whether alternations of at least that length historically tend to continue (scanned as "at least
  minLength", not an exact-length match, so a long live run still has a meaningful historical sample to compare
  against).
- `buildNGramTable(seq, order)` / `estimateFor(table, context)` — the general order-N conditional model
  (`markov`), which conditions on the literal trailing N-gram rather than requiring it to be a uniform run.
- `transitionMatrix1(seq)` / `transitionMatrix2(seq)` — the full 1st/2nd-order empirical transition matrices,
  returned for display (`transition-matrix`'s `indicators.matrix`).

Every estimate function returns `null` (not a guessed 50/50) when there isn't enough trailing structure to even
ask the question (e.g. `currentStreak` shorter than the requested run length) — plugins treat `null` as "insufficient
data" and `SKIP`, distinct from "measured, but the edge/sample-size threshold wasn't met".

## Sequence recovery ladder

`sequence-recovery` is the configurable N-step recovery ladder (default 1%/3%/6%/10% of bankroll,
`ladderStep1..4`). It deliberately does **not** double the stake immediately after a loss — see the plugin's own
warning in `sequenceStrategies.ts`. Its pipeline, each step re-derived from `ctx.ownTrades` on every call:

1. **No active sequence** (`status.depth === 0`) → a fresh attempt 1, direction chosen by `initialDirection`
   (`PERSISTENCE` follows the last completed round, `REVERSAL` fades it, or a fixed side).
2. **Mid-ladder, no confirmed reversal yet** — a loss on direction `D` means the round's own outcome was
   `opposite(D)` by definition, so that's already the first occurrence of the reversal; the ladder then waits
   (`SKIP`, never `WAIT` — see below) for:
   - the trailing run to actually be running in `opposite(D)` (`AWAITING_REVERSAL` otherwise),
   - the run it reversed _from_ to have been at least `requiredPreviousStreak` long (`REVERSAL_TOO_WEAK` otherwise),
   - `confirmationCount` consecutive occurrences of `opposite(D)`, **counting the loss round itself as #1**
     (`CONFIRMATION_PENDING` while still short).
3. **Confirmed** — bets `opposite(D)` (`confirmationAction: FOLLOW`) or fades back to `D` (`FADE`), sized by
   `stakeFor`: `FIXED_PERCENTAGE` uses `ladderStep[depth]`; `TARGET_RECOVERY` instead sizes to recoup prior
   losses plus `targetProfitPercent` of bankroll at the _live_ pool's payout multiplier
   (`(priorLosses + targetProfit) / (payout − 1)`), falling back to the fixed ladder percentage — with an
   honest note in `rationale` — when no pool reading exists (always true in backtests).
4. **Ladder exhausted** (`depth >= maxRecoverySteps`) → `SKIP` with reason `RECOVERY_COOLDOWN` for
   `recoveryCooldownRounds` rounds, then a fresh attempt (`SEQUENCE_FAILED_RESET`), not a silent giving-up.

State is never stored in a separate table: `recoveryStatus()` folds `ctx.ownTrades` (most-recent-first) counting
consecutive `LOST` results since the last `WON`, skipping `REFUNDED`/still-open trades transparently (a cancelled
round neither advances nor resets the ladder). Because `ownTrades` comes from the same persisted trade ledger
every other part of the app reads, the ladder recovers its exact position after a process restart for free, and
`evaluate` stays a pure function of context like every other plugin.

Every "not yet" state returns `SKIP`, not `WAIT`: `WAIT` decisions are never persisted (they exist so a strategy
can ask "give me a few more seconds within this same round"), whereas the recovery ladder's waiting is for _future
rounds_ to resolve — that can only be expressed, and made visible in the dashboard's decision history, as a
persisted `SKIP` with an explanatory `indicators.trigger`.

The ladder's stakes and cooldown are its own internal bookkeeping; they never bypass the global risk engine
(`evaluateRisk`), which independently enforces `maxDailyLossWei`, `maxExposureWei`, `maxStakeWei`, and
`maxConsecutiveLosses`/`cooldownRounds` regardless of what the ladder computes.

## Configuration (editable at runtime, per strategy)

```json
{
  "params": { "window": 5, "minMovePct": 0 },
  "timing": { "entrySecondsBeforeLock": 30, "minSecondsBeforeLock": 8 },
  "sizing": { "mode": "FIXED", "fixedBnb": 0.001, "fraction": 0.01 },
  "directions": "BOTH",
  "limits": {
    "maxStakeBnb": 0.005,
    "maxDailyLossBnb": 0.02,
    "maxConsecutiveLosses": 4,
    "cooldownRounds": 12,
    "maxExposureBnb": 0.01,
    "stopLossBnb": 0.05,
    "minConfidence": 0.5,
    "minExpectedEdge": 0.02,
    "maxBankrollFraction": 0.02
  }
}
```

Strategy limits are merged with the global environment limits and can only make them stricter.
The engine evaluates a strategy once the open round is within `entrySecondsBeforeLock`; `WAIT` re-evaluates on the
next poll until `minSecondsBeforeLock`, after which the round is recorded as `ENTRY_WINDOW_CLOSED`.

## Risk checks recorded with every decision

Gates (`BOT_RUNNING`, `STRATEGY_ENABLED`, `MARKET_ACTIVE`, plus `PAPER_TRADING_ENABLED`/`STRATEGY_PAPER_ENABLED` or
the live gate `LIVE_TRADING_ENABLED`, `LIVE_ARMED`, `WALLET_VALID`, `STRATEGY_LIVE_ENABLED`, `CIRCUIT_BREAKER`),
then `ROUND_VALID`, `SINGLE_BET_PER_ROUND`, `MIN_CONFIDENCE`, `MIN_EXPECTED_EDGE`, `STAKE_CAP` (clamps),
`MIN_BET`, `MAX_DAILY_LOSS`, `STOP_LOSS`, `CONSECUTIVE_LOSSES`, `MAX_EXPOSURE`, `SUFFICIENT_BALANCE`,
`MIN_WALLET_BALANCE`, `MAX_GAS_PRICE`. All rules are evaluated (no short-circuit) so the dashboard can show every
reason; the first failure becomes the decision's `reason`.

## Writing a new strategy

1. Add a `StrategyPlugin` to `packages/core/src/strategy/builtins.ts` (or a new file) and include it in
   `BUILTIN_STRATEGIES`. Keep `evaluate` pure and fast; return `SKIP` with a rationale instead of throwing.
2. Add unit tests next to `packages/core/test/strategy.test.ts` (use `buildContext` with `series()` fixtures).
3. Restart the server: the plugin is seeded as a disabled strategy row. Backtest it on the **Backtesting** page, then
   enable paper trading, and only then consider live.

Several configured instances of one plugin are supported at the data level (`strategies.slug` vs `plugin`).

## Modes and parity

The same `decide()` runs in all three modes; only the adapter differs:

|               | BACKTEST                                           | PAPER                                    | LIVE                                     |
| ------------- | -------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Decision time | lock − entry seconds (single evaluation)           | engine window, chain time                | engine window, chain time                |
| Fill          | immediate, simulated gas                           | immediate, simulated gas                 | on-chain transaction, real gas           |
| Payout        | contract formula with stake added to recorded pool | same                                     | exact contract payout on the real pool   |
| Bankroll      | simulated                                          | `PAPER_STARTING_BANKROLL` + realized P&L | wallet balance + open stakes + unclaimed |
| Claims        | simulated claim gas                                | simulated claim gas                      | real claim transactions                  |
