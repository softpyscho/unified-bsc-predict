/**
 * Strategy → Signal → sizing → risk. Identical for BACKTEST, PAPER and LIVE; only the execution adapter
 * that consumes the resulting Decision differs.
 */
import type { Direction } from '../round.js';
import type { GateCheck, RiskCheck, RiskLimits, RiskState } from '../risk.js';
import { evaluateRisk } from '../risk.js';
import type { RunMode } from '../trade.js';
import { bnbToWei, mulWeiByFraction, stakeBnbToWei } from '../units.js';
import type { StrategyConfig } from './config.js';
import type { Signal, StrategyContext, StrategyPlugin } from './types.js';
import { SIGNAL_ACTIONS, signalDirection } from './types.js';

export type DecisionKind = 'WAIT' | 'TRADE' | 'NO_TRADE';

export interface Decision {
  kind: DecisionKind;
  signal: Signal | null;
  direction: Direction | null;
  intendedStakeWei: bigint | null;
  stakeWei: bigint | null;
  expectedEdge: number | null;
  checks: RiskCheck[];
  /** Machine-readable reason code followed by human detail, e.g. "RISK_REJECTED: MAX_EXPOSURE: ...". */
  reason: string;
  error: string | null;
}

export interface DecideInput {
  mode: RunMode;
  plugin: StrategyPlugin;
  config: StrategyConfig;
  ctx: StrategyContext;
  limits: RiskLimits;
  state: RiskState;
  gates: readonly GateCheck[];
  minBetWei: bigint;
}

export function computeStake(sizing: StrategyConfig['sizing'], bankrollWei: bigint, signal: Signal): bigint {
  switch (sizing.mode) {
    case 'FIXED':
      return bnbToWei(sizing.fixedBnb);
    case 'BANKROLL_FRACTION':
      return mulWeiByFraction(bankrollWei > 0n ? bankrollWei : 0n, sizing.fraction);
    case 'SIGNAL':
      return signal.stakeBnb !== undefined && Number.isFinite(signal.stakeBnb) && signal.stakeBnb > 0
        ? stakeBnbToWei(signal.stakeBnb)
        : bnbToWei(sizing.fixedBnb);
  }
}

function isValidSignal(s: unknown): s is Signal {
  if (typeof s !== 'object' || s === null) return false;
  const sig = s as Partial<Signal>;
  return (
    typeof sig.action === 'string' &&
    SIGNAL_ACTIONS.includes(sig.action) &&
    typeof sig.confidence === 'number' &&
    Number.isFinite(sig.confidence) &&
    sig.confidence >= 0 &&
    sig.confidence <= 1 &&
    typeof sig.rationale === 'string'
  );
}

const noTrade = (reason: string, extra: Partial<Decision> = {}): Decision => ({
  kind: 'NO_TRADE',
  signal: null,
  direction: null,
  intendedStakeWei: null,
  stakeWei: null,
  expectedEdge: null,
  checks: [],
  reason,
  error: null,
  ...extra,
});

export function decide(input: DecideInput): Decision {
  const { plugin, config, ctx } = input;

  let signal: Signal;
  try {
    const out: unknown = plugin.evaluate(ctx, config.params);
    if (!isValidSignal(out))
      return noTrade('INVALID_SIGNAL', { error: `strategy returned an invalid signal` });
    signal = out;
  } catch (err) {
    // A strategy failure must never result in a trade.
    const message = err instanceof Error ? err.message : String(err);
    return noTrade(`STRATEGY_ERROR: ${message}`, { error: message });
  }

  if (signal.action === 'WAIT') {
    if (ctx.betting.secondsToLock <= input.limits.minSecondsBeforeLock) {
      return noTrade('ENTRY_WINDOW_CLOSED: strategy was still waiting at the latest safe entry time', {
        signal,
      });
    }
    return { ...noTrade('WAIT', { signal }), kind: 'WAIT' };
  }
  if (signal.action === 'SKIP') return noTrade(`STRATEGY_SKIP: ${signal.rationale}`, { signal });

  const direction = signalDirection(signal.action)!;
  if (
    (config.directions === 'BULL_ONLY' && direction !== 'BULL') ||
    (config.directions === 'BEAR_ONLY' && direction !== 'BEAR')
  ) {
    return noTrade(`DIRECTION_FILTER: ${direction} not allowed (${config.directions})`, {
      signal,
      direction,
    });
  }

  const pool = ctx.betting.pool;
  const payout = pool ? (direction === 'BULL' ? pool.bullPayout : pool.bearPayout) : null;
  const expectedEdge = payout === null ? null : signal.confidence * payout - 1;

  const intended = computeStake(config.sizing, input.state.bankrollWei, signal);
  const risk = evaluateRisk({
    mode: input.mode,
    direction,
    stakeWei: intended,
    confidence: signal.confidence,
    expectedEdge,
    minBetWei: input.minBetWei,
    limits: input.limits,
    state: input.state,
    gates: input.gates,
  });

  if (!risk.approved) {
    return noTrade(`RISK_REJECTED: ${risk.rejection}`, {
      signal,
      direction,
      intendedStakeWei: intended,
      expectedEdge,
      checks: risk.checks,
    });
  }
  return {
    kind: 'TRADE',
    signal,
    direction,
    intendedStakeWei: intended,
    stakeWei: risk.stakeWei,
    expectedEdge,
    checks: risk.checks,
    reason: `APPROVED: ${signal.rationale}`,
    error: null,
  };
}

export function lookbackFor(plugin: StrategyPlugin, config: StrategyConfig): number {
  return Math.max(1, Math.min(10_000, Math.floor(plugin.lookback(config.params))));
}
