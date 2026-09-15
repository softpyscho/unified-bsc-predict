import { describe, expect, it } from 'vitest';
import { NO_COSTS, estimateBalancePull, expectedValue, lcg } from '../src/index.js';

const base = {
  direction: 'BULL' as const,
  pool: { bullAmount: 1, bearAmount: 1 },
  stakeBnb: 0.01,
  treasuryFeeBps: 300,
};

describe('edge engine', () => {
  it('charges the fee and the dilution caused by the bettor’s own stake', () => {
    const e = expectedValue({ ...base, probability: 0.5, model: NO_COSTS })!;
    expect(e.displayedMultiplier).toBeCloseTo(1.94, 10);
    expect(e.dilutedMultiplier).toBeCloseTo((2.01 * 0.97) / 1.01, 10);
    expect(e.expectedMultiplier).toBeCloseTo(e.dilutedMultiplier, 10);
    // A fair coin at 1.93x loses about 3.5% per bet.
    expect(e.ev).toBeCloseTo(0.5 * e.dilutedMultiplier - 1, 10);
    expect(e.breakEvenProbability).toBeCloseTo(1 / e.dilutedMultiplier, 10);
  });

  it('is zero exactly at the break-even probability, including gas', () => {
    const model = { gasBetBnb: 0.00005, gasClaimBnb: 0.00004, balancePull: 0.5 };
    const probe = expectedValue({
      ...base,
      pool: { bullAmount: 1, bearAmount: 3 },
      probability: 0.3,
      model,
    })!;
    const at = expectedValue({
      ...base,
      pool: { bullAmount: 1, bearAmount: 3 },
      probability: probe.breakEvenProbability!,
      model,
    })!;
    expect(at.ev).toBeCloseTo(0, 12);
    expect(at.evBnb).toBeCloseTo(0, 12);
    expect(probe.breakEvenProbability!).toBeGreaterThan(1 / probe.expectedMultiplier);
  });

  it('expects late money to erode long odds and improve the favourite', () => {
    const pool = { bullAmount: 1, bearAmount: 3 }; // BULL is the long-odds side at decision time
    const model = { ...NO_COSTS, balancePull: 0.6 };
    const long = expectedValue({ ...base, pool, probability: 0.5, model })!;
    const fav = expectedValue({ ...base, pool, direction: 'BEAR', probability: 0.5, model })!;
    expect(long.expectedMultiplier).toBeLessThan(long.dilutedMultiplier);
    expect(fav.expectedMultiplier).toBeGreaterThan(fav.dilutedMultiplier);
    // Full pull: both sides converge on the balanced multiplier.
    const full = { ...NO_COSTS, balancePull: 1 };
    const a = expectedValue({ ...base, pool, probability: 0.5, model: full })!;
    const b = expectedValue({ ...base, pool, direction: 'BEAR', probability: 0.5, model: full })!;
    expect(a.expectedMultiplier).toBeCloseTo(b.expectedMultiplier, 10);
  });

  it('shows why a long-odds side is not free money: large stakes dilute it away', () => {
    const thin = { ...base, pool: { bullAmount: 0.1, bearAmount: 5 } };
    const small = expectedValue({ ...thin, stakeBnb: 0.01, probability: 0.1, model: NO_COSTS })!;
    const large = expectedValue({ ...thin, stakeBnb: 1, probability: 0.1, model: NO_COSTS })!;
    expect(small.displayedMultiplier).toBeCloseTo((5.1 * 0.97) / 0.1, 10);
    expect(large.dilutedMultiplier).toBeLessThan(small.dilutedMultiplier / 5);
    expect(large.ev).toBeLessThan(small.ev);
  });

  it('handles empty pools and rejects nonsense input', () => {
    const empty = expectedValue({
      ...base,
      pool: { bullAmount: 0, bearAmount: 2 },
      probability: 0.5,
      model: NO_COSTS,
    })!;
    expect(empty.displayedMultiplier).toBeNull();
    expect(empty.dilutedMultiplier).toBeCloseTo((2.01 * 0.97) / 0.01, 10);
    const nothing = expectedValue({
      ...base,
      pool: { bullAmount: 0, bearAmount: 0 },
      probability: 1,
      model: NO_COSTS,
    })!;
    expect(nothing.expectedMultiplier).toBeCloseTo(0.97, 10); // only your own stake back, minus the fee
    expect(expectedValue({ ...base, stakeBnb: 0, probability: 0.5, model: NO_COSTS })).toBeNull();
    expect(expectedValue({ ...base, probability: Number.NaN, model: NO_COSTS })).toBeNull();
  });

  it('recovers a known balance pull from noisy observations', () => {
    const rand = lcg(5);
    const pairs = Array.from({ length: 2000 }, () => {
      const decisionShare = 0.1 + rand() * 0.8;
      const finalShare = decisionShare + 0.7 * (0.5 - decisionShare) + (rand() - 0.5) * 0.05;
      return { decisionShare, finalShare };
    });
    const est = estimateBalancePull(pairs)!;
    expect(est.n).toBe(2000);
    expect(est.pull).toBeCloseTo(0.7, 1);
    expect(estimateBalancePull(pairs.slice(0, 5))).toBeNull();
  });
});
