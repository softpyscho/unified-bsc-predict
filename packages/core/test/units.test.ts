import { describe, expect, it } from 'vitest';
import { bnbToWei, stakeBnbToWei, weiToBnb, WEI_PER_BNB } from '../src/index.js';

describe('stakeBnbToWei', () => {
  it('handles a plain, round amount identically to bnbToWei', () => {
    expect(stakeBnbToWei(0.03)).toBe(bnbToWei(0.03));
  });

  it('does not throw on a computed float whose shortest round-trip decimal needs more than 18 digits', () => {
    // A real sequence-recovery TARGET_RECOVERY stake observed from a live backtest: (priorLosses + targetProfit)
    // / (payout - 1). Its shortest round-trip decimal needs 19 fractional digits, which bnbToWei rejects
    // outright — stakeBnbToWei must round instead of throwing, since this is an ordinary computed stake, not
    // bad input.
    const dirty = 0.0075525410348666125;
    expect(() => bnbToWei(dirty)).toThrow(/more than 18 decimals/);
    expect(() => stakeBnbToWei(dirty)).not.toThrow();
    expect(weiToBnb(stakeBnbToWei(dirty))).toBeCloseTo(dirty, 9);
  });

  it('rounds to the nearest 1e-9 BNB rather than truncating', () => {
    // 1e-9 BNB = 1e9 wei exactly; a value just past the midpoint should round up.
    const wei = stakeBnbToWei(0.0000000015); // 1.5e-9
    expect(wei).toBe(2_000_000_000n); // rounds to 2e-9 BNB
  });

  it('rejects non-finite or negative input', () => {
    expect(() => stakeBnbToWei(Number.NaN)).toThrow();
    expect(() => stakeBnbToWei(-0.01)).toThrow();
  });

  it('is exact for zero and for whole BNB amounts', () => {
    expect(stakeBnbToWei(0)).toBe(0n);
    expect(stakeBnbToWei(5)).toBe(5n * WEI_PER_BNB);
  });
});
