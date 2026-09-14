import { describe, expect, it } from 'vitest';
import {
  benjaminiHochberg,
  meanInterval,
  normalCdf,
  pearson,
  proportionZTest,
  quantile,
  twoSidedP,
  wilsonInterval,
} from '../src/index.js';

describe('statistics', () => {
  it('normal CDF and two-sided p-values match reference values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
    expect(twoSidedP(1.959963984540054)).toBeCloseTo(0.05, 6);
    expect(twoSidedP(3)).toBeCloseTo(0.0026998, 6);
    // Relative accuracy in the far tail, where BH decisions on large searches live.
    expect(twoSidedP(6) / 1.973175e-9).toBeCloseTo(1, 4);
  });

  it('Wilson interval matches the textbook 50/100 case', () => {
    const ci = wilsonInterval(50, 100)!;
    expect(ci.low).toBeCloseTo(0.4038, 4);
    expect(ci.high).toBeCloseTo(0.5962, 4);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('proportion z-test', () => {
    const t = proportionZTest(60, 100, 0.5)!;
    expect(t.z).toBeCloseTo(2, 10);
    expect(t.pValue).toBeCloseTo(0.0455, 4);
  });

  it('Benjamini–Hochberg adjusts, keeps input order, and stays monotone', () => {
    expect(benjaminiHochberg([0.01, 0.04, 0.03, 0.005])).toEqual([0.02, 0.04, 0.04, 0.02]);
    const adj = benjaminiHochberg([0.5, 0.001, 0.9, 0.02]);
    expect(adj[1]).toBeCloseTo(0.004, 12);
    expect(adj[3]).toBeCloseTo(0.04, 12);
    expect(adj.every((p) => p <= 1)).toBe(true);
  });

  it('a large search of pure-noise p-values yields no BH discoveries at 5%', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const ps = Array.from({ length: 1000 }, () => rand());
    const raw = ps.filter((p) => p < 0.05).length;
    const adjusted = benjaminiHochberg(ps).filter((p) => p < 0.05).length;
    expect(raw).toBeGreaterThan(20); // ~50 "significant" by chance before correction
    expect(adjusted).toBe(0);
  });

  it('mean interval, Pearson and quantiles', () => {
    const m = meanInterval([1, 2, 3, 4])!;
    expect(m.mean).toBe(2.5);
    expect(m.se).toBeCloseTo(Math.sqrt(1.6666666666666667 / 4), 12);
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])!.r).toBeCloseTo(1, 12);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});
