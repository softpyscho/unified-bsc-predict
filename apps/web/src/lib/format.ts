import { weiToBnbString } from '@bsc/core';

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Exact wei → "1,234.5678" BNB text (display only; truncates to `dp` decimals). */
export function bnb(wei: string | bigint | null | undefined, dp = 4): string {
  if (wei === null || wei === undefined) return '—';
  const s = weiToBnbString(typeof wei === 'bigint' ? wei : BigInt(wei), dp);
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  const body = f ? `${group(i!)}.${f}` : group(i!);
  return neg ? `−${body}` : body;
}

export function signedBnb(wei: string | bigint | null | undefined, dp = 4): string {
  if (wei === null || wei === undefined) return '—';
  const v = typeof wei === 'bigint' ? wei : BigInt(wei);
  return v > 0n ? `+${bnb(v, dp)}` : bnb(v, dp);
}

export function tone(wei: string | bigint | null | undefined): string {
  if (wei === null || wei === undefined) return '';
  const v = typeof wei === 'bigint' ? wei : BigInt(wei);
  return v > 0n ? 'pos' : v < 0n ? 'neg' : '';
}

/** Lossy wei → BNB number for charts only. */
export function bnbNum(wei: string | bigint | null | undefined): number {
  if (wei === null || wei === undefined) return 0;
  return Number(weiToBnbString(typeof wei === 'bigint' ? wei : BigInt(wei), 8));
}

export function pct(x: number | null | undefined, dp = 1): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(dp)}%`;
}

export function usd(price8: number | null | undefined, dp = 2): string {
  if (price8 === null || price8 === undefined) return '—';
  return `$${(price8 / 1e8).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function priceDelta(
  from: number | null | undefined,
  to: number | null | undefined,
): { text: string; cls: string } {
  if (from === null || from === undefined || to === null || to === undefined) return { text: '—', cls: '' };
  const d = (to - from) / 1e8;
  const text = `${d > 0 ? '+' : d < 0 ? '−' : ''}$${Math.abs(d).toFixed(3)}`;
  return { text, cls: d > 0 ? 'pos' : d < 0 ? 'neg' : '' };
}

export function num(x: number | null | undefined, dp = 2): string {
  return x === null || x === undefined || !Number.isFinite(x)
    ? '—'
    : x.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function dateTime(sec: number | null | undefined): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
}

export function dateTimeMs(ms: number | null | undefined): string {
  return ms ? dateTime(ms / 1000) : '—';
}

export function shortDate(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

export function timeAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function countdown(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function short(hex: string | null | undefined, head = 6, tail = 4): string {
  if (!hex) return '—';
  return hex.length <= head + tail + 2 ? hex : `${hex.slice(0, head + 2)}…${hex.slice(-tail)}`;
}

export function explorer(kind: 'tx' | 'address', value: string, chainId = 56): string {
  return `https://${chainId === 97 ? 'testnet.' : ''}bscscan.com/${kind}/${value}`;
}
