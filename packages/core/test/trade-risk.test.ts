import { describe, expect, it } from 'vitest';
import type { RiskInput, RiskState } from '../src/index.js';
import {
  assertTransition,
  bnbToWei,
  canTransition,
  claimStatusFor,
  evaluateRisk,
  gweiToWei,
  mergeLimits,
  resultFor,
  tradeNetPnl,
} from '../src/index.js';
import { LOOSE_LIMITS } from './fixtures.js';

describe('trade state machine', () => {
  it('allows the documented lifecycle', () => {
    expect(canTransition('PENDING', 'SUBMITTING')).toBe(true);
    expect(canTransition('SUBMITTING', 'SUBMITTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'SETTLED')).toBe(true);
    expect(canTransition('PENDING', 'FAILED')).toBe(true);
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true); // paper / imported
  });
  it('rejects rewriting history', () => {
    expect(() => assertTransition('SETTLED', 'CONFIRMED')).toThrow(/Illegal/);
    expect(() => assertTransition('FAILED', 'CONFIRMED')).toThrow(/Illegal/);
    expect(() => assertTransition('CONFIRMED', 'FAILED')).toThrow(/Illegal/);
    expect(() => assertTransition('SUBMITTED', 'PENDING')).toThrow(/Illegal/);
  });
  it('classifies results and claims', () => {
    expect(resultFor('BULL', 'BULL')).toBe('WON');
    expect(resultFor('TIE', 'BULL')).toBe('LOST');
    expect(resultFor('CANCELLED', 'BEAR')).toBe('REFUNDED');
    expect(claimStatusFor('LIVE', 'WON')).toBe('UNCLAIMED');
    expect(claimStatusFor('LIVE', 'REFUNDED')).toBe('UNCLAIMED');
    expect(claimStatusFor('LIVE', 'LOST')).toBe('NOT_APPLICABLE');
    expect(claimStatusFor('PAPER', 'WON')).toBe('NOT_APPLICABLE');
  });
  it('computes net P&L including gas, and gas-only loss for failed trades', () => {
    const base = { amount: bnbToWei(1), gasCost: bnbToWei('0.001'), claimGasCost: bnbToWei('0.001') };
    expect(tradeNetPnl({ ...base, status: 'SETTLED', payout: bnbToWei('1.9') })).toBe(bnbToWei('0.898'));
    expect(tradeNetPnl({ ...base, status: 'SETTLED', payout: 0n, claimGasCost: null })).toBe(
      -bnbToWei('1.001'),
    );
    expect(tradeNetPnl({ ...base, status: 'FAILED', payout: null, claimGasCost: null })).toBe(
      -bnbToWei('0.001'),
    );
    expect(tradeNetPnl({ ...base, status: 'CONFIRMED', payout: null })).toBeNull();
  });
});

const baseState: RiskState = {
  bankrollWei: bnbToWei(1),
  availableWei: bnbToWei(1),
  exposureWei: 0n,
  dailyNetPnlWei: 0n,
  strategyNetPnlWei: 0n,
  lossStreak: 0,
  roundsSinceLastLoss: null,
  alreadyBetThisRound: false,
  roundOpen: true,
  secondsToLock: 20,
  gasPriceWei: gweiToWei(1),
  gasReserveWei: bnbToWei('0.0001'),
};

function risk(overrides: Partial<Omit<RiskInput, 'state'>> & { state?: Partial<RiskState> } = {}) {
  const { state, ...rest } = overrides;
  return evaluateRisk({
    mode: 'PAPER',
    direction: 'BULL',
    stakeWei: bnbToWei('0.01'),
    confidence: 0.5,
    expectedEdge: null,
    minBetWei: bnbToWei('0.001'),
    limits: LOOSE_LIMITS,
    gates: [],
    ...rest,
    state: { ...baseState, ...state },
  });
}

const failed = (r: ReturnType<typeof risk>) => r.checks.filter((c) => !c.passed).map((c) => c.rule);

describe('risk engine', () => {
  it('approves a normal trade and evaluates every rule', () => {
    const r = risk();
    expect(r.approved).toBe(true);
    expect(r.stakeWei).toBe(bnbToWei('0.01'));
    expect(r.checks.map((c) => c.rule)).toEqual([
      'ROUND_VALID',
      'SINGLE_BET_PER_ROUND',
      'MIN_CONFIDENCE',
      'MIN_EXPECTED_EDGE',
      'ESCALATION_GATE',
      'STAKE_CAP',
      'MIN_STAKE',
      'MIN_BET',
      'MAX_DAILY_LOSS',
      'STOP_LOSS',
      'CONSECUTIVE_LOSSES',
      'MAX_EXPOSURE',
      'SUFFICIENT_BALANCE',
      'MIN_WALLET_BALANCE',
      'MAX_GAS_PRICE',
    ]);
  });

  it('clamps stake to the per-trade and bankroll-fraction caps', () => {
    const r = risk({ limits: { ...LOOSE_LIMITS, maxStakeWei: bnbToWei('0.005') } });
    expect(r.approved).toBe(true);
    expect(r.stakeWei).toBe(bnbToWei('0.005'));
    const f = risk({ limits: { ...LOOSE_LIMITS, maxBankrollFraction: 0.002 } });
    expect(f.stakeWei).toBe(bnbToWei('0.002'));
  });

  it('rejects when the clamped stake falls below the contract minimum', () => {
    const r = risk({ limits: { ...LOOSE_LIMITS, maxBankrollFraction: 0.0005 } });
    expect(failed(r)).toEqual(['MIN_BET']);
  });

  it('raises a stake below the minimum stake floor', () => {
    const r = risk({
      stakeWei: bnbToWei('0.001'),
      limits: { ...LOOSE_LIMITS, minStakeWei: bnbToWei('0.01') },
    });
    expect(r.approved).toBe(true);
    expect(r.stakeWei).toBe(bnbToWei('0.01'));
  });

  it('rejects when the caps leave less than the minimum stake', () => {
    const r = risk({
      limits: { ...LOOSE_LIMITS, minStakeWei: bnbToWei('0.01'), maxStakeWei: bnbToWei('0.005') },
    });
    expect(failed(r)).toEqual(['MIN_STAKE']);
  });

  it('only allows stakes above the escalation threshold after enough consecutive losses', () => {
    const limits = {
      ...LOOSE_LIMITS,
      escalationStakeWei: bnbToWei('0.16'),
      escalationMinLossStreak: 5,
    };
    const locked = risk({ stakeWei: bnbToWei('0.3'), limits, state: { lossStreak: 4 } });
    expect(locked.approved).toBe(true);
    expect(locked.stakeWei).toBe(bnbToWei('0.16'));
    const unlocked = risk({ stakeWei: bnbToWei('0.3'), limits, state: { lossStreak: 5 } });
    expect(unlocked.stakeWei).toBe(bnbToWei('0.3'));
    const small = risk({ stakeWei: bnbToWei('0.04'), limits, state: { lossStreak: 0 } });
    expect(small.stakeWei).toBe(bnbToWei('0.04'));
  });

  it.each([
    ['ROUND_VALID', { state: { secondsToLock: 3 } }],
    ['ROUND_VALID', { state: { roundOpen: false } }],
    ['SINGLE_BET_PER_ROUND', { state: { alreadyBetThisRound: true } }],
    ['MIN_CONFIDENCE', { confidence: 0.4, limits: { ...LOOSE_LIMITS, minConfidence: 0.55 } }],
    ['MIN_EXPECTED_EDGE', { expectedEdge: null, limits: { ...LOOSE_LIMITS, minExpectedEdge: 0.02 } }],
    ['MIN_EXPECTED_EDGE', { expectedEdge: 0.01, limits: { ...LOOSE_LIMITS, minExpectedEdge: 0.02 } }],
    [
      'MAX_DAILY_LOSS',
      {
        state: { dailyNetPnlWei: -bnbToWei('0.05') },
        limits: { ...LOOSE_LIMITS, maxDailyLossWei: bnbToWei('0.05') },
      },
    ],
    [
      'STOP_LOSS',
      { state: { strategyNetPnlWei: -bnbToWei(1) }, limits: { ...LOOSE_LIMITS, stopLossWei: bnbToWei(1) } },
    ],
    [
      'CONSECUTIVE_LOSSES',
      {
        state: { lossStreak: 3, roundsSinceLastLoss: 2 },
        limits: { ...LOOSE_LIMITS, maxConsecutiveLosses: 3, cooldownRounds: 5 },
      },
    ],
    [
      'MAX_EXPOSURE',
      { state: { exposureWei: bnbToWei('0.995') }, limits: { ...LOOSE_LIMITS, maxExposureWei: bnbToWei(1) } },
    ],
    ['SUFFICIENT_BALANCE', { state: { availableWei: bnbToWei('0.01') } }],
    [
      'MAX_GAS_PRICE',
      { state: { gasPriceWei: gweiToWei(10) }, limits: { ...LOOSE_LIMITS, maxGasPriceWei: gweiToWei(5) } },
    ],
  ] as const)('rejects on %s', (rule, overrides) => {
    const r = risk(overrides as Parameters<typeof risk>[0]);
    expect(r.approved).toBe(false);
    expect(failed(r)).toContain(rule);
    expect(r.rejection).toMatch(new RegExp(`^${rule}`));
  });

  it('lets the loss-streak cooldown expire', () => {
    const limits = { ...LOOSE_LIMITS, maxConsecutiveLosses: 3, cooldownRounds: 5 };
    expect(risk({ limits, state: { lossStreak: 3, roundsSinceLastLoss: 6 } }).approved).toBe(true);
  });

  it('enforces the minimum wallet balance after stake and gas', () => {
    const r = risk({
      limits: { ...LOOSE_LIMITS, minWalletBalanceWei: bnbToWei('0.995') },
    });
    expect(failed(r)).toEqual(['MIN_WALLET_BALANCE']);
  });

  it('includes external gates such as the live-trading gate', () => {
    const r = risk({
      mode: 'LIVE',
      gates: [{ rule: 'LIVE_TRADING_ENABLED', passed: false, detail: 'disabled in env' }],
    });
    expect(r.approved).toBe(false);
    expect(r.rejection).toBe('LIVE_TRADING_ENABLED: disabled in env');
  });

  it('merging strategy limits can only tighten global limits', () => {
    const global = {
      ...LOOSE_LIMITS,
      maxStakeWei: bnbToWei('0.01'),
      maxConsecutiveLosses: 5,
      maxGasPriceWei: gweiToWei(5),
    };
    const merged = mergeLimits(global, {
      maxStakeWei: bnbToWei(10),
      maxConsecutiveLosses: 3,
      maxGasPriceWei: gweiToWei(50),
      minConfidence: 0.6,
      minSecondsBeforeLock: 2,
    });
    expect(merged.maxStakeWei).toBe(bnbToWei('0.01'));
    expect(merged.maxConsecutiveLosses).toBe(3);
    expect(merged.maxGasPriceWei).toBe(gweiToWei(5));
    expect(merged.minConfidence).toBe(0.6);
    expect(merged.minSecondsBeforeLock).toBe(5);
  });
});
