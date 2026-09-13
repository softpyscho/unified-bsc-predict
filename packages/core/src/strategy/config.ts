/** Per-strategy configuration stored as JSON; editable at runtime without touching strategy code. */
import type { RiskLimits } from '../risk.js';
import { bnbToWei } from '../units.js';
import type { ParamValues, ValidationResult } from './params.js';
import { validateParams } from './params.js';
import type { StrategyPlugin } from './types.js';

export type SizingMode = 'FIXED' | 'BANKROLL_FRACTION' | 'SIGNAL';
export type DirectionFilter = 'BOTH' | 'BULL_ONLY' | 'BEAR_ONLY';

export interface StrategyConfig {
  params: ParamValues;
  timing: {
    /** Start evaluating this many seconds before lock. */
    entrySecondsBeforeLock: number;
    /** Never submit later than this many seconds before lock (tx must be mined before lock). */
    minSecondsBeforeLock: number;
  };
  sizing: {
    mode: SizingMode;
    fixedBnb: number;
    fraction: number;
  };
  directions: DirectionFilter;
  /** Strategy-level limits. They can only tighten the global limits, never loosen them. */
  limits: StrategyLimitsConfig;
}

export interface StrategyLimitsConfig {
  maxStakeBnb?: number;
  maxBankrollFraction?: number;
  maxDailyLossBnb?: number;
  maxConsecutiveLosses?: number;
  cooldownRounds?: number;
  maxExposureBnb?: number;
  stopLossBnb?: number;
  minConfidence?: number;
  minExpectedEdge?: number;
}

export const DEFAULT_TIMING: StrategyConfig['timing'] = {
  entrySecondsBeforeLock: 30,
  minSecondsBeforeLock: 8,
};

export function defaultStrategyConfig(plugin: StrategyPlugin, fixedBnb = 0.001): StrategyConfig {
  return {
    params: { ...plugin.defaults },
    timing: { ...DEFAULT_TIMING },
    sizing: { mode: 'FIXED', fixedBnb, fraction: 0.01 },
    directions: 'BOTH',
    limits: {},
  };
}

const LIMIT_KEYS: readonly (keyof StrategyLimitsConfig)[] = [
  'maxStakeBnb',
  'maxBankrollFraction',
  'maxDailyLossBnb',
  'maxConsecutiveLosses',
  'cooldownRounds',
  'maxExposureBnb',
  'stopLossBnb',
  'minConfidence',
  'minExpectedEdge',
];

/** Validates a (possibly partial) config and fills defaults. */
export function parseStrategyConfig(
  plugin: StrategyPlugin,
  input: unknown,
): ValidationResult<StrategyConfig> {
  const raw = (input ?? {}) as Partial<Record<keyof StrategyConfig, unknown>>;
  const base = defaultStrategyConfig(plugin);
  const errors: string[] = [];

  const params = validateParams(plugin.params, plugin.defaults, raw.params ?? {});
  if (!params.ok) errors.push(...params.errors.map((e) => `params.${e}`));

  const timing = {
    ...base.timing,
    ...((raw.timing as object | undefined) ?? {}),
  } as StrategyConfig['timing'];
  if (!isNum(timing.entrySecondsBeforeLock, 1, 300))
    errors.push('timing.entrySecondsBeforeLock must be 1..300');
  if (!isNum(timing.minSecondsBeforeLock, 1, 120)) errors.push('timing.minSecondsBeforeLock must be 1..120');
  if (timing.minSecondsBeforeLock >= timing.entrySecondsBeforeLock)
    errors.push('timing.minSecondsBeforeLock must be smaller than entrySecondsBeforeLock');

  const sizing = {
    ...base.sizing,
    ...((raw.sizing as object | undefined) ?? {}),
  } as StrategyConfig['sizing'];
  if (!['FIXED', 'BANKROLL_FRACTION', 'SIGNAL'].includes(sizing.mode)) errors.push('sizing.mode is invalid');
  if (!isNum(sizing.fixedBnb, 0, 1_000)) errors.push('sizing.fixedBnb must be 0..1000');
  if (!isNum(sizing.fraction, 0, 1)) errors.push('sizing.fraction must be 0..1');

  const directions = (raw.directions ?? base.directions) as DirectionFilter;
  if (!['BOTH', 'BULL_ONLY', 'BEAR_ONLY'].includes(directions)) errors.push('directions is invalid');

  const limitsRaw = (raw.limits ?? {}) as Record<string, unknown>;
  const limits: StrategyLimitsConfig = {};
  for (const [key, value] of Object.entries(limitsRaw)) {
    if (!LIMIT_KEYS.includes(key as keyof StrategyLimitsConfig)) {
      errors.push(`limits.${key} is not a known limit`);
    } else if (value !== null && value !== undefined) {
      if (!isNum(value, 0, 1_000_000)) errors.push(`limits.${key} must be a non-negative number`);
      else limits[key as keyof StrategyLimitsConfig] = value as number;
    }
  }
  if (limits.maxBankrollFraction !== undefined && limits.maxBankrollFraction > 1)
    errors.push('limits.maxBankrollFraction must be <= 1');
  if (limits.minConfidence !== undefined && limits.minConfidence > 1)
    errors.push('limits.minConfidence must be <= 1');

  if (errors.length > 0 || !params.ok) return { ok: false, errors };
  return { ok: true, value: { params: params.value, timing, sizing, directions, limits } };
}

function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** Converts strategy-level limits (BNB floats) to risk-limit overrides (wei). */
export function strategyLimitOverrides(cfg: StrategyConfig): Partial<RiskLimits> {
  const l = cfg.limits;
  const out: Partial<RiskLimits> = { minSecondsBeforeLock: cfg.timing.minSecondsBeforeLock };
  if (l.maxStakeBnb !== undefined) out.maxStakeWei = bnbToWei(l.maxStakeBnb);
  if (l.maxBankrollFraction !== undefined) out.maxBankrollFraction = l.maxBankrollFraction;
  if (l.maxDailyLossBnb !== undefined) out.maxDailyLossWei = bnbToWei(l.maxDailyLossBnb);
  if (l.maxConsecutiveLosses !== undefined) out.maxConsecutiveLosses = Math.floor(l.maxConsecutiveLosses);
  if (l.cooldownRounds !== undefined) out.cooldownRounds = Math.floor(l.cooldownRounds);
  if (l.maxExposureBnb !== undefined) out.maxExposureWei = bnbToWei(l.maxExposureBnb);
  if (l.stopLossBnb !== undefined) out.stopLossWei = bnbToWei(l.stopLossBnb);
  if (l.minConfidence !== undefined) out.minConfidence = l.minConfidence;
  if (l.minExpectedEdge !== undefined) out.minExpectedEdge = l.minExpectedEdge;
  return out;
}
