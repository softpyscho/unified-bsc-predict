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
  indicators?: Record<string, number | string | boolean | null>;
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
| `price`        | latest Chainlink BNB/USD                                      |       **null**       |      ✓       |
| `bankrollBnb`  | bankroll used for sizing                                      |      simulated       |   account    |

`buildContext` enforces the visibility rules: an ended round is visible once `closeTime ≤ now`, a cancelled
round only once `closeTime + buffer ≤ now`, the live round's lock price only after its lock time, and the betting
round's pool is never available in backtests (it is only final at lock). A strategy that relies on `pool` or `price`
therefore behaves differently in backtests — the built-ins only use `history`, so their backtests are faithful.

## Built-in plugins

| Plugin               | Origin                        | Logic                                                                         |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `follow-last-winner` | bsc-predict-bot `SimpleBot`   | bet the winner of the latest completed round (skip ties); `invert` fades it   |
| `momentum`           | bsc-predict-bot `TrendingBot` | last N round close prices never step against a direction → bet it; min move % |
| `streak-reversal`    | new                           | after a run of N identical outcomes, FADE (bet against) or FOLLOW             |
| `manual`             | dashboard bet modal           | operator orders; same sizing/risk/execution path                              |

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
