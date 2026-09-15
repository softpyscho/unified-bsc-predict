/**
 * Risk engine. Pure and shared by backtest, paper and live so that a strategy is judged by the same rules
 * everywhere. Every rule is evaluated (no short-circuit) so the UI can show the full picture of a decision.
 */
import type { Direction } from './round.js';
import type { RunMode } from './trade.js';
import { minBigInt, mulWeiByFraction, weiToBnbString } from './units.js';

export interface RiskLimits {
  maxStakeWei: bigint;
  /** Every stake is raised to at least this (then still subject to every cap). 0 disables. */
  minStakeWei: bigint;
  /**
   * Stakes above this are only allowed once the strategy has `escalationMinLossStreak` consecutive losses;
   * until then they are clamped to it. 0 disables.
   */
  escalationStakeWei: bigint;
  escalationMinLossStreak: number;
  maxBankrollFraction: number;
  /** Reject new trades once today's (UTC) realized net P&L is at or below −maxDailyLoss. 0 disables. */
  maxDailyLossWei: bigint;
  /** Consecutive losses that trigger a cooldown. 0 disables. */
  maxConsecutiveLosses: number;
  cooldownRounds: number;
  maxExposureWei: bigint;
  minWalletBalanceWei: bigint;
  maxGasPriceWei: bigint | null;
  /** Cumulative net loss of a strategy (per mode) at which it stops trading. null disables. */
  stopLossWei: bigint | null;
  minConfidence: number;
  minExpectedEdge: number | null;
  minSecondsBeforeLock: number;
  /**
   * Live bets need a positive expected value after fee, dilution, gas and late money. Paper and backtests are
   * unaffected (they trade for observation). A strategy can switch it on but never off.
   */
  liveRequiresPositiveEv: boolean;
}

/** Strategy limits may only tighten global limits. */
export function mergeLimits(global: RiskLimits, overrides: Partial<RiskLimits>): RiskLimits {
  const minPositive = (a: number, b: number | undefined) => {
    if (b === undefined) return a;
    if (a === 0) return b;
    if (b === 0) return a;
    return Math.min(a, b);
  };
  const minPositiveWei = (a: bigint, b: bigint | undefined) => {
    if (b === undefined) return a;
    if (a === 0n) return b;
    if (b === 0n) return a;
    return a < b ? a : b;
  };
  const minNullable = (a: bigint | null, b: bigint | null | undefined) =>
    b === undefined || b === null ? a : a === null ? b : a < b ? a : b;
  return {
    maxStakeWei:
      overrides.maxStakeWei === undefined
        ? global.maxStakeWei
        : minBigInt(global.maxStakeWei, overrides.maxStakeWei),
    minStakeWei: global.minStakeWei,
    escalationStakeWei: minPositiveWei(global.escalationStakeWei, overrides.escalationStakeWei),
    escalationMinLossStreak: Math.max(global.escalationMinLossStreak, overrides.escalationMinLossStreak ?? 0),
    maxBankrollFraction: Math.min(global.maxBankrollFraction, overrides.maxBankrollFraction ?? Infinity),
    maxDailyLossWei: minPositiveWei(global.maxDailyLossWei, overrides.maxDailyLossWei),
    maxConsecutiveLosses: minPositive(global.maxConsecutiveLosses, overrides.maxConsecutiveLosses),
    cooldownRounds: Math.max(global.cooldownRounds, overrides.cooldownRounds ?? 0),
    maxExposureWei:
      overrides.maxExposureWei === undefined
        ? global.maxExposureWei
        : minBigInt(global.maxExposureWei, overrides.maxExposureWei),
    minWalletBalanceWei:
      overrides.minWalletBalanceWei !== undefined &&
      overrides.minWalletBalanceWei > global.minWalletBalanceWei
        ? overrides.minWalletBalanceWei
        : global.minWalletBalanceWei,
    maxGasPriceWei: minNullable(global.maxGasPriceWei, overrides.maxGasPriceWei),
    stopLossWei: minNullable(global.stopLossWei, overrides.stopLossWei),
    minConfidence: Math.max(global.minConfidence, overrides.minConfidence ?? 0),
    minExpectedEdge:
      overrides.minExpectedEdge === undefined || overrides.minExpectedEdge === null
        ? global.minExpectedEdge
        : Math.max(global.minExpectedEdge ?? -Infinity, overrides.minExpectedEdge),
    minSecondsBeforeLock: Math.max(global.minSecondsBeforeLock, overrides.minSecondsBeforeLock ?? 0),
    liveRequiresPositiveEv: global.liveRequiresPositiveEv || overrides.liveRequiresPositiveEv === true,
  };
}

export interface RiskState {
  /** Equity basis for fraction sizing: spendable balance + stake currently at risk. */
  bankrollWei: bigint;
  /** Spendable balance now (live: wallet balance; paper/backtest: simulated cash). */
  availableWei: bigint;
  /** Stake in trades that are not yet settled (same mode and wallet). */
  exposureWei: bigint;
  dailyNetPnlWei: bigint;
  strategyNetPnlWei: bigint;
  lossStreak: number;
  roundsSinceLastLoss: number | null;
  alreadyBetThisRound: boolean;
  roundOpen: boolean;
  secondsToLock: number;
  gasPriceWei: bigint | null;
  /** Gas that must remain available for the bet (and later claim). */
  gasReserveWei: bigint;
}

/** Externally evaluated preconditions (e.g. the live-trading gate). */
export interface GateCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface RiskInput {
  mode: RunMode;
  direction: Direction;
  stakeWei: bigint;
  confidence: number;
  expectedEdge: number | null;
  minBetWei: bigint;
  limits: RiskLimits;
  state: RiskState;
  gates: readonly GateCheck[];
}

export type RiskCheck = GateCheck;

export interface RiskResult {
  approved: boolean;
  stakeWei: bigint;
  checks: RiskCheck[];
  /** First failed rule, e.g. "MAX_EXPOSURE: ...". */
  rejection: string | null;
}

const bnb = (wei: bigint) => `${weiToBnbString(wei, 6)} BNB`;

export function evaluateRisk(input: RiskInput): RiskResult {
  const { limits, state } = input;
  const checks: RiskCheck[] = [...input.gates];
  const add = (rule: string, passed: boolean, detail: string) => checks.push({ rule, passed, detail });

  add(
    'ROUND_VALID',
    state.roundOpen && state.secondsToLock >= limits.minSecondsBeforeLock,
    state.roundOpen
      ? `${state.secondsToLock.toFixed(1)}s to lock (minimum ${limits.minSecondsBeforeLock}s)`
      : 'round is not open for bets',
  );
  add(
    'SINGLE_BET_PER_ROUND',
    !state.alreadyBetThisRound,
    state.alreadyBetThisRound ? 'a bet already exists for this round' : 'no existing bet',
  );
  add(
    'MIN_CONFIDENCE',
    input.confidence >= limits.minConfidence,
    `confidence ${input.confidence.toFixed(3)} (minimum ${limits.minConfidence})`,
  );
  if (limits.minExpectedEdge === null) {
    add('MIN_EXPECTED_EDGE', true, 'disabled');
  } else if (input.expectedEdge === null) {
    add('MIN_EXPECTED_EDGE', false, 'edge not computable: betting pool not observable');
  } else {
    add(
      'MIN_EXPECTED_EDGE',
      input.expectedEdge >= limits.minExpectedEdge,
      `edge ${(input.expectedEdge * 100).toFixed(2)}% (minimum ${(limits.minExpectedEdge * 100).toFixed(2)}%)`,
    );
  }
  if (input.mode === 'LIVE' && limits.liveRequiresPositiveEv) {
    add(
      'POSITIVE_EXPECTED_VALUE',
      input.expectedEdge !== null && input.expectedEdge > 0,
      input.expectedEdge === null
        ? 'expected value not computable: betting pool not observable'
        : `expected value ${(input.expectedEdge * 100).toFixed(2)}% per unit staked after fee, dilution, gas and late money (live bets need > 0)`,
    );
  }

  const fractionCap = mulWeiByFraction(state.bankrollWei, limits.maxBankrollFraction);
  const floored =
    limits.minStakeWei > 0n && input.stakeWei < limits.minStakeWei ? limits.minStakeWei : input.stakeWei;
  const escalationLocked =
    limits.escalationStakeWei > 0n && state.lossStreak < limits.escalationMinLossStreak;
  const gated = escalationLocked && floored > limits.escalationStakeWei ? limits.escalationStakeWei : floored;
  const stake = minBigInt(gated, limits.maxStakeWei, fractionCap);
  add(
    'ESCALATION_GATE',
    true,
    limits.escalationStakeWei === 0n
      ? 'disabled'
      : gated < floored
        ? `stake clamped ${bnb(floored)} → ${bnb(gated)}: stakes above ${bnb(limits.escalationStakeWei)} need ${limits.escalationMinLossStreak} consecutive losses (have ${state.lossStreak})`
        : `${state.lossStreak}/${limits.escalationMinLossStreak} consecutive losses; stakes above ${bnb(limits.escalationStakeWei)} ${escalationLocked ? 'locked' : 'unlocked'}`,
  );
  add(
    'STAKE_CAP',
    true,
    stake < gated
      ? `stake clamped ${bnb(gated)} → ${bnb(stake)} (max ${bnb(limits.maxStakeWei)}, ${limits.maxBankrollFraction * 100}% of bankroll = ${bnb(fractionCap)})`
      : `stake ${bnb(stake)} within caps`,
  );
  add(
    'MIN_STAKE',
    stake >= limits.minStakeWei,
    limits.minStakeWei === 0n
      ? 'disabled'
      : stake < limits.minStakeWei
        ? `caps leave ${bnb(stake)}, below the ${bnb(limits.minStakeWei)} minimum stake`
        : floored > input.stakeWei
          ? `stake raised ${bnb(input.stakeWei)} → ${bnb(floored)} (minimum ${bnb(limits.minStakeWei)})`
          : `stake at or above the ${bnb(limits.minStakeWei)} minimum`,
  );
  add(
    'MIN_BET',
    stake >= input.minBetWei && stake > 0n,
    `stake ${bnb(stake)} (contract minimum ${bnb(input.minBetWei)})`,
  );

  add(
    'MAX_DAILY_LOSS',
    limits.maxDailyLossWei === 0n || state.dailyNetPnlWei > -limits.maxDailyLossWei,
    limits.maxDailyLossWei === 0n
      ? 'disabled'
      : `today's net P&L ${bnb(state.dailyNetPnlWei)} (limit −${bnb(limits.maxDailyLossWei)})`,
  );
  add(
    'STOP_LOSS',
    limits.stopLossWei === null || state.strategyNetPnlWei > -limits.stopLossWei,
    limits.stopLossWei === null
      ? 'disabled'
      : `strategy net P&L ${bnb(state.strategyNetPnlWei)} (stop at −${bnb(limits.stopLossWei)})`,
  );
  const inCooldown =
    limits.maxConsecutiveLosses > 0 &&
    state.lossStreak >= limits.maxConsecutiveLosses &&
    state.roundsSinceLastLoss !== null &&
    state.roundsSinceLastLoss <= limits.cooldownRounds;
  add(
    'CONSECUTIVE_LOSSES',
    !inCooldown,
    limits.maxConsecutiveLosses === 0
      ? 'disabled'
      : `${state.lossStreak} consecutive losses (limit ${limits.maxConsecutiveLosses}, cooldown ${limits.cooldownRounds} rounds, ${state.roundsSinceLastLoss ?? '-'} since last loss)`,
  );
  add(
    'MAX_EXPOSURE',
    state.exposureWei + stake <= limits.maxExposureWei,
    `exposure ${bnb(state.exposureWei)} + ${bnb(stake)} (limit ${bnb(limits.maxExposureWei)})`,
  );
  const required = stake + state.gasReserveWei;
  add(
    'SUFFICIENT_BALANCE',
    state.availableWei >= required,
    `available ${bnb(state.availableWei)}, required ${bnb(required)}`,
  );
  add(
    'MIN_WALLET_BALANCE',
    state.availableWei - required >= limits.minWalletBalanceWei,
    `balance after trade ${bnb(state.availableWei - required)} (minimum ${bnb(limits.minWalletBalanceWei)})`,
  );
  if (limits.maxGasPriceWei === null || state.gasPriceWei === null) {
    add('MAX_GAS_PRICE', true, 'not applicable');
  } else {
    add(
      'MAX_GAS_PRICE',
      state.gasPriceWei <= limits.maxGasPriceWei,
      `gas price ${Number(state.gasPriceWei) / 1e9} gwei (max ${Number(limits.maxGasPriceWei) / 1e9} gwei)`,
    );
  }

  const failed = checks.find((c) => !c.passed);
  return {
    approved: failed === undefined,
    stakeWei: stake,
    checks,
    rejection: failed ? `${failed.rule}: ${failed.detail}` : null,
  };
}
