/** Research statistics: confidence intervals, significance tests and multiple-testing correction. */

export const Z95 = 1.959963984540054;

const ERFC_COEFFS = [
  -1.26551223, 1.00002368, 0.37409196, 0.09678418, -0.18628806, 0.27886807, -1.13520398, 1.48851587,
  -0.82215223, 0.17087277,
] as const;

/** Complementary error function (Numerical Recipes erfcc): relative error < 1.2e-7, including the tails. */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  let acc = 0;
  for (let i = ERFC_COEFFS.length - 1; i >= 1; i--) acc = ERFC_COEFFS[i]! + t * acc;
  const r = t * Math.exp(-z * z + ERFC_COEFFS[0] + t * acc);
  return x >= 0 ? r : 2 - r;
}

export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** Two-sided p-value of a standard-normal statistic. */
export function twoSidedP(z: number): number {
  return erfc(Math.abs(z) / Math.SQRT2);
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(successes: number, n: number, z = Z95): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Two-sided one-sample z-test of an observed proportion against `p0`. */
export function proportionZTest(
  successes: number,
  n: number,
  p0: number,
): { z: number; pValue: number } | null {
  if (n <= 0 || p0 <= 0 || p0 >= 1) return null;
  const z = (successes / n - p0) / Math.sqrt((p0 * (1 - p0)) / n);
  return { z, pValue: twoSidedP(z) };
}

/** Benjamini–Hochberg adjusted p-values (false discovery rate), returned in the input order. */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = order[rank - 1]!;
    running = Math.min(running, (p * m) / rank);
    adjusted[i] = running;
  }
  return adjusted;
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Mean with its standard error and a normal-approximation 95% interval. */
export function meanInterval(
  xs: readonly number[],
): { mean: number; se: number; low: number; high: number; n: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs)!;
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  const se = Math.sqrt(ss / (n - 1) / n);
  return { mean: m, se, low: m - Z95 * se, high: m + Z95 * se, n };
}

/** Pearson correlation with a Fisher-z two-sided p-value. */
export function pearson(
  xs: readonly number[],
  ys: readonly number[],
): { r: number; pValue: number; n: number } | null {
  const n = xs.length;
  if (n !== ys.length || n < 4) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  const fz = 0.5 * Math.log((1 + r) / (1 - r)) * Math.sqrt(n - 3);
  return { r, pValue: twoSidedP(fz), n };
}

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
