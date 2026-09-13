import type { Direction, RoundView } from '../round.js';
import type { RunMode, TradeResult, TradeStatus } from '../trade.js';
import type { ParamSpec, ParamValues } from './params.js';

export type SignalAction = 'BUY_UP' | 'BUY_DOWN' | 'WAIT' | 'SKIP';
export const SIGNAL_ACTIONS: readonly SignalAction[] = ['BUY_UP', 'BUY_DOWN', 'WAIT', 'SKIP'];

/** Any JSON-serializable value — indicators are stored and displayed as JSON, so nesting is fine. */
export type IndicatorValue =
  string | number | boolean | null | readonly IndicatorValue[] | { readonly [key: string]: IndicatorValue };

export interface Signal {
  action: SignalAction;
  /** Estimated probability (0..1) that the chosen side wins. Used for min-confidence and edge checks. */
  confidence: number;
  /** Optional stake recommendation in BNB, used only when the strategy's sizing mode is SIGNAL. */
  stakeBnb?: number;
  rationale: string;
  riskScore?: number;
  /** Explainability payload (e.g. the transition matrix, the recovery ladder state). Any JSON value. */
  indicators?: Record<string, IndicatorValue>;
}

/** The round currently accepting bets. `pool` is null when it cannot be observed (backtests). */
export interface BettingRoundView {
  epoch: number;
  startTime: number;
  lockTime: number;
  secondsToLock: number;
  pool: {
    bullAmount: number;
    bearAmount: number;
    totalAmount: number;
    bullPayout: number | null;
    bearPayout: number | null;
  } | null;
}

/** The locked round that is running (epoch − 1). Its close price is unknown by definition. */
export interface LiveRoundView {
  epoch: number;
  lockTime: number | null;
  closeTime: number | null;
  lockPrice: number | null;
}

/**
 * One of THIS strategy's own past trades (same strategy, same mode), most recent first. This is how a
 * sequence-recovery strategy recovers its exact state after a restart: the state is never stored separately —
 * it is re-derived, deterministically, from the persisted trade ledger every time `evaluate` runs. `status`
 * lets a strategy tell "settled and lost" apart from "still open" (e.g. a live bet awaiting confirmation).
 */
export interface OwnTradeView {
  epoch: number;
  direction: Direction;
  amountBnb: number;
  status: TradeStatus;
  result: TradeResult | null;
}

/**
 * Everything a strategy may see. Built by `buildContext`, which guarantees that no information from after
 * `now` is present — the same builder is used for backtest, paper and live evaluation.
 */
export interface StrategyContext {
  mode: RunMode;
  /** Decision time, unix seconds (chain time in live/paper, simulated in backtests). */
  now: number;
  betting: BettingRoundView;
  live: LiveRoundView | null;
  /** Final rounds known at `now`, oldest → newest, at most the plugin's lookback. */
  history: readonly RoundView[];
  /** This strategy's own past trades (same strategy + mode), most recent first, bounded (see context.ts). */
  ownTrades: readonly OwnTradeView[];
  /** Latest oracle price in USD. Not available in backtests (null). */
  price: { value: number; updatedAt: number } | null;
  bankrollBnb: number;
}

export interface StrategyPlugin<P extends ParamValues = ParamValues> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly params: readonly ParamSpec[];
  readonly defaults: P;
  /** Number of final rounds of history the plugin needs. */
  lookback(params: P): number;
  /** Pure function of the context. Must not perform I/O and must not throw for normal inputs. */
  evaluate(ctx: StrategyContext, params: P): Signal;
}

export function signalDirection(action: SignalAction): Direction | null {
  if (action === 'BUY_UP') return 'BULL';
  if (action === 'BUY_DOWN') return 'BEAR';
  return null;
}
