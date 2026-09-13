/** Unit handling. Money is always bigint wei; oracle prices are integers scaled by 1e8. */

export const BNB_DECIMALS = 18;
export const WEI_PER_BNB = 10n ** 18n;
export const PRICE_DECIMALS = 8;
export const PRICE_SCALE = 10 ** PRICE_DECIMALS;
export const BPS_DENOMINATOR = 10_000n;
export const GWEI = 10n ** 9n;

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** Converts a non-negative decimal BNB amount to wei with no floating point rounding. */
export function bnbToWei(value: string | number): bigint {
  const text = typeof value === 'number' ? numberToDecimalString(value) : value.trim();
  const match = DECIMAL_RE.exec(text);
  if (!match) throw new RangeError(`Invalid BNB amount: ${String(value)}`);
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > BNB_DECIMALS) throw new RangeError(`BNB amount has more than 18 decimals: ${text}`);
  return BigInt(whole) * WEI_PER_BNB + BigInt(frac.padEnd(BNB_DECIMALS, '0'));
}

/**
 * Shortest round-trip decimal of a float (String(0.1) === "0.1"), with exponent notation expanded.
 * toFixed(18) must not be used: it exposes binary noise (0.1 → "0.100000000000000006").
 */
function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid BNB amount: ${value}`);
  const text = String(value);
  const exp = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!exp) return text;
  const fraction = exp[2] ?? '';
  const digits = `${exp[1]}${fraction}`;
  const shift = Number(exp[3]) - fraction.length;
  if (shift >= 0) return digits + '0'.repeat(shift);
  const padded = digits.padStart(-shift + 1, '0');
  return `${padded.slice(0, shift)}.${padded.slice(shift)}`;
}

/** Exact decimal string of a wei amount, e.g. -1500000000000000n -> "-0.0015". */
export function weiToBnbString(wei: bigint, maxDecimals = BNB_DECIMALS): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_BNB;
  let frac = (abs % WEI_PER_BNB).toString().padStart(BNB_DECIMALS, '0').slice(0, maxDecimals);
  frac = frac.replace(/0+$/, '');
  const body = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return negative && body !== '0' ? `-${body}` : body;
}

/** Lossy conversion for charts and display only — never use for accounting. */
export function weiToBnb(wei: bigint): number {
  return Number(weiToBnbString(wei));
}

export function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

/** Oracle integer (8 decimals) to a USD float, for display and strategy inputs. */
export function priceToUsd(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  return raw / PRICE_SCALE;
}

export function minBigInt(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a));
}

export function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b > a ? b : a));
}

/** Ratio of two bigints as a float, safe for very large operands. */
export function ratio(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  const SCALE = 10n ** 12n;
  return Number((numerator * SCALE) / denominator) / Number(SCALE);
}

/**
 * Converts a strategy-computed BNB stake (an arbitrary float, e.g. from a division) to wei, rounded to the
 * nearest 1e-9 BNB. `bnbToWei` parses the number's shortest round-trip decimal string and rejects anything
 * needing more than 18 fractional digits — safe for operator-entered amounts, but a computed value like
 * `(priorLosses + targetProfit) / (payout - 1)` can legitimately need 19+ digits to round-trip exactly even
 * though it's a perfectly ordinary stake. Rounding first (1e-9 BNB is far finer than any real stake needs)
 * sidesteps that entirely instead of asking every stake-computing strategy to pre-round itself.
 */
export function stakeBnbToWei(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid BNB amount: ${value}`);
  const ROUND_SCALE = 1_000_000_000n; // 1e9: round to the nearest 1e-9 BNB
  const rounded = BigInt(Math.round(value * Number(ROUND_SCALE)));
  return rounded * (WEI_PER_BNB / ROUND_SCALE);
}

/** Multiplies wei by a float fraction (e.g. bankroll * 0.05), rounding down to the wei. */
export function mulWeiByFraction(wei: bigint, fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction < 0) throw new RangeError(`Invalid fraction ${fraction}`);
  const SCALE = 1_000_000_000n;
  return (wei * BigInt(Math.floor(fraction * Number(SCALE)))) / SCALE;
}
