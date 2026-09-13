import { describe, expect, it } from 'vitest';
import type { RoundRecord } from '../src/index.js';
import {
  bnbToWei,
  deriveOutcome,
  deriveRoundStatus,
  mulWeiByFraction,
  payoutMultiplier,
  ratio,
  settledPayout,
  simulatedPayout,
  weiToBnbString,
} from '../src/index.js';

/** Real rounds from bsc-predict-updater data/v2/main/rounds.csv (PancakeSwap V2, treasury fee 3%). */
const R408633: RoundRecord = {
  epoch: 408633,
  startTime: 1756587476,
  lockTime: 1756587776,
  closeTime: 1756588082,
  lockPrice: 85933296956,
  closePrice: 85911406197,
  lockOracleId: '55340232221131082507',
  closeOracleId: '55340232221131082516',
  totalAmount: 1547242055094045268n,
  bullAmount: 922406506093782956n,
  bearAmount: 624835549000262312n,
  rewardBaseCalAmount: 624835549000262312n,
  rewardAmount: 1500824793441223910n,
  oracleCalled: true,
};
const R408634: RoundRecord = {
  ...R408633,
  epoch: 408634,
  lockPrice: 85911406197,
  closePrice: 85990000000,
  totalAmount: 1564958215521781753n,
  bullAmount: 912504246102161807n,
  bearAmount: 652453969419619946n,
  rewardBaseCalAmount: 912504246102161807n,
  rewardAmount: 1518009469056128301n,
};

describe('units', () => {
  it('converts BNB decimals to wei exactly', () => {
    expect(bnbToWei('0.001')).toBe(1_000_000_000_000_000n);
    expect(bnbToWei(0.1)).toBe(100_000_000_000_000_000n);
    expect(bnbToWei(0.07)).toBe(70_000_000_000_000_000n);
    expect(bnbToWei(1e-7)).toBe(100_000_000_000n);
    expect(bnbToWei(1.5e-7)).toBe(150_000_000_000n);
    expect(bnbToWei(1e21)).toBe(10n ** 39n);
    expect(bnbToWei('12.000000000000000001')).toBe(12_000_000_000_000_000_001n);
    expect(() => bnbToWei('-1')).toThrow();
    expect(() => bnbToWei('1e5')).toThrow();
    expect(() => bnbToWei('0.0000000000000000001')).toThrow();
  });
  it('formats wei as BNB without rounding errors', () => {
    expect(weiToBnbString(-1_500_000_000_000_000n)).toBe('-0.0015');
    expect(weiToBnbString(0n)).toBe('0');
    expect(weiToBnbString(1234567890123456789n, 4)).toBe('1.2345');
  });
  it('handles fractions and ratios', () => {
    expect(mulWeiByFraction(bnbToWei(2), 0.05)).toBe(bnbToWei('0.1'));
    expect(ratio(1n, 3n)).toBeCloseTo(0.333333333333, 10);
    expect(ratio(1n, 0n)).toBeNull();
  });
});

describe('round status', () => {
  const base: RoundRecord = {
    ...R408633,
    lockPrice: null,
    closePrice: null,
    lockOracleId: null,
    closeOracleId: null,
    oracleCalled: false,
  };
  const { startTime, lockTime, closeTime } = base as {
    startTime: number;
    lockTime: number;
    closeTime: number;
  };

  it('walks through the lifecycle', () => {
    expect(deriveRoundStatus(base, startTime - 1, 30)).toBe('UPCOMING');
    expect(deriveRoundStatus(base, startTime + 1, 30)).toBe('OPEN');
    expect(deriveRoundStatus(base, lockTime + 1, 30)).toBe('LOCKING');
    const locked = { ...base, lockPrice: 1, lockOracleId: '9' };
    expect(deriveRoundStatus(locked, lockTime + 1, 30)).toBe('LIVE');
    expect(deriveRoundStatus(locked, closeTime + 5, 30)).toBe('CLOSING');
    expect(deriveRoundStatus(locked, closeTime + 31, 30)).toBe('CANCELLED');
    expect(deriveRoundStatus(R408633, closeTime + 5, 30)).toBe('ENDED');
  });

  it('only cancels after close + buffer (never on a temporary observation)', () => {
    expect(deriveRoundStatus(base, closeTime + 30, 30)).not.toBe('CANCELLED');
    expect(deriveRoundStatus(base, closeTime + 31, 30)).toBe('CANCELLED');
  });

  it('derives outcomes', () => {
    expect(deriveOutcome(R408633, 'ENDED')).toBe('BEAR');
    expect(deriveOutcome(R408634, 'ENDED')).toBe('BULL');
    expect(deriveOutcome({ ...R408633, closePrice: R408633.lockPrice }, 'ENDED')).toBe('TIE');
    expect(deriveOutcome(base, 'CANCELLED')).toBe('CANCELLED');
    expect(deriveOutcome(base, 'LIVE')).toBeNull();
  });
});

describe('payouts', () => {
  it('reproduces the contract reward amount (3% treasury fee)', () => {
    for (const r of [R408633, R408634]) {
      const total = r.bullAmount + r.bearAmount;
      expect(total).toBe(r.totalAmount);
      expect(total - (total * 300n) / 10_000n).toBe(r.rewardAmount);
    }
  });

  it('settled payout equals the simulated payout of the same stake removed from the pool', () => {
    const stake = bnbToWei('0.1');
    const exact = settledPayout(R408633, 'BEAR', 'BEAR', stake);
    const simulated = simulatedPayout(
      { bullAmount: R408633.bullAmount, bearAmount: R408633.bearAmount - stake },
      'BEAR',
      'BEAR',
      stake,
      300,
    );
    expect(simulated).toBe(exact);
    expect(exact).toBe((stake * R408633.rewardAmount) / R408633.rewardBaseCalAmount);
  });

  it('losing side, ties and cancellations', () => {
    const stake = bnbToWei(1);
    expect(settledPayout(R408633, 'BEAR', 'BULL', stake)).toBe(0n);
    expect(settledPayout(R408633, 'TIE', 'BULL', stake)).toBe(0n);
    expect(settledPayout(R408633, 'CANCELLED', 'BULL', stake)).toBe(stake);
    expect(simulatedPayout(R408633, 'TIE', 'BEAR', stake, 300)).toBe(0n);
    expect(simulatedPayout(R408633, 'CANCELLED', 'BEAR', stake, 300)).toBe(stake);
  });

  it('models the dilution caused by our own stake', () => {
    const pool = { bullAmount: bnbToWei(1), bearAmount: bnbToWei(1) };
    const small = simulatedPayout(pool, 'BULL', 'BULL', bnbToWei('0.01'), 300);
    const large = simulatedPayout(pool, 'BULL', 'BULL', bnbToWei(1), 300);
    expect(Number(small) / 1e16).toBeGreaterThan(Number(large) / 1e18); // multiplier shrinks with size
    expect(payoutMultiplier(pool, 'BULL', 300)).toBeCloseTo(1.94, 10);
    expect(payoutMultiplier({ bullAmount: 0n, bearAmount: 1n }, 'BULL', 300)).toBeNull();
  });
});
