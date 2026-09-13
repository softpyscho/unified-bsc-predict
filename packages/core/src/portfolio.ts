/**
 * Portfolio analytics. Deterministic: every money figure is summed in bigint wei, entries are ordered by a
 * total order (time, epoch, id), and floats are only produced for final ratios.
 */
import type { Direction } from './round.js';
import type { RunMode, TradeResult, TradeStatus } from './trade.js';
import { isOpenStatus, tradeGrossPnl, tradeNetPnl } from './trade.js';
import { ratio, weiToBnb } from './units.js';

export interface LedgerEntry {
  id: number | string;
  mode: RunMode;
  epoch: number;
  /** Unix seconds. */
  placedAt: number;
  /** Unix seconds at which the result became known. */
  settledAt: number | null;
  strategy: string | null;
  market: string;
  direction: Direction;
  amount: bigint;
  status: TradeStatus;
  result: TradeResult | null;
  payout: bigint | null;
  gasCost: bigint | null;
  claimGasCost: bigint | null;
}

export interface PerformanceSummary {
  settledTrades: number;
  openTrades: number;
  failedTrades: number;
  wins: number;
  losses: number;
  refunds: number;
  winRate: number | null;
  lossRate: number | null;
  totalWagered: bigint;
  openExposure: bigint;
  totalPayout: bigint;
  grossPnl: bigint;
  fees: bigint;
  netPnl: bigint;
  roi: number | null;
  avgWin: bigint | null;
  avgLoss: bigint | null;
  profitFactor: number | null;
  expectancy: bigint | null;
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: { kind: 'WIN' | 'LOSS' | null; length: number };
  avgStake: bigint | null;
  maxStake: bigint;
  maxDrawdown: bigint;
  maxDrawdownPct: number | null;
}

export interface EquityPoint {
  t: number;
  epoch: number;
  id: number | string;
  net: bigint;
  cumulativePnl: bigint;
  bankroll: bigint | null;
  drawdown: bigint;
}

export interface PeriodPnl {
  period: string;
  netPnl: bigint;
  trades: number;
  wins: number;
}

export interface Bucket {
  label: string;
  count: number;
}

export interface PortfolioReport {
  summary: PerformanceSummary;
  byStrategy: Record<string, PerformanceSummary>;
  byMarket: Record<string, PerformanceSummary>;
  byDirection: Record<Direction, PerformanceSummary>;
  daily: PeriodPnl[];
  weekly: PeriodPnl[];
  monthly: PeriodPnl[];
  equity: EquityPoint[];
  returnsHistogram: Bucket[];
  stakeHistogram: Bucket[];
  capitalUtilization: number | null;
  startingBankroll: bigint | null;
}

/** Events that move realized equity: settled trades and failed trades that burned gas. */
function realizedEvents(entries: readonly LedgerEntry[]): { entry: LedgerEntry; t: number; net: bigint }[] {
  const events: { entry: LedgerEntry; t: number; net: bigint }[] = [];
  for (const e of entries) {
    if (e.status === 'SETTLED') {
      events.push({ entry: e, t: e.settledAt ?? e.placedAt, net: tradeNetPnl(e) ?? 0n });
    } else if (e.status === 'FAILED') {
      const net = tradeNetPnl(e) ?? 0n;
      if (net !== 0n) events.push({ entry: e, t: e.placedAt, net });
    }
  }
  events.sort(
    (a, b) =>
      a.t - b.t ||
      a.entry.epoch - b.entry.epoch ||
      String(a.entry.id).localeCompare(String(b.entry.id), 'en', { numeric: true }),
  );
  return events;
}

export function computeSummary(
  entries: readonly LedgerEntry[],
  startingBankroll: bigint | null = null,
): PerformanceSummary {
  let settledTrades = 0;
  let openTrades = 0;
  let failedTrades = 0;
  let wins = 0;
  let losses = 0;
  let refunds = 0;
  let totalWagered = 0n;
  let openExposure = 0n;
  let totalPayout = 0n;
  let grossPnl = 0n;
  let fees = 0n;
  let winSum = 0n;
  let lossSum = 0n;
  let positive = 0n;
  let negative = 0n;
  let maxStake = 0n;
  let stakeSum = 0n;
  let stakeCount = 0;

  for (const e of entries) {
    if (isOpenStatus(e.status)) {
      // Gas of open trades is accounted for when they settle, keeping netPnl equal to the equity curve.
      openTrades++;
      openExposure += e.amount;
    }
    if (e.status !== 'FAILED') {
      stakeSum += e.amount;
      stakeCount++;
      if (e.amount > maxStake) maxStake = e.amount;
    }
  }

  let longestWin = 0;
  let longestLoss = 0;
  let run = 0;
  let runKind: 'WIN' | 'LOSS' | null = null;
  let equity = startingBankroll ?? 0n;
  let peak = equity;
  let maxDrawdown = 0n;
  let maxDrawdownPct: number | null = startingBankroll === null ? null : 0;

  for (const { entry: e, net } of realizedEvents(entries)) {
    if (e.status === 'FAILED') {
      failedTrades++;
      fees += -net;
    } else {
      settledTrades++;
      totalWagered += e.amount;
      totalPayout += e.payout ?? 0n;
      grossPnl += tradeGrossPnl(e) ?? 0n;
      fees += (e.gasCost ?? 0n) + (e.claimGasCost ?? 0n);
      if (e.result === 'WON' || e.result === 'LOST') {
        const kind = e.result === 'WON' ? 'WIN' : 'LOSS';
        if (kind === 'WIN') {
          wins++;
          winSum += net;
        } else {
          losses++;
          lossSum += net;
        }
        run = runKind === kind ? run + 1 : 1;
        runKind = kind;
        if (kind === 'WIN') longestWin = Math.max(longestWin, run);
        else longestLoss = Math.max(longestLoss, run);
      } else {
        refunds++;
      }
      if (net > 0n) positive += net;
      else negative += net;
    }
    equity += net;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (startingBankroll !== null && peak > 0n) {
      const pct = ratio(dd, peak) ?? 0;
      if (pct > (maxDrawdownPct ?? 0)) maxDrawdownPct = pct;
    }
  }
  failedTrades += entries.filter((e) => e.status === 'FAILED' && (tradeNetPnl(e) ?? 0n) === 0n).length;

  const decided = wins + losses;
  const netPnl = grossPnl - fees;
  return {
    settledTrades,
    openTrades,
    failedTrades,
    wins,
    losses,
    refunds,
    winRate: decided > 0 ? wins / decided : null,
    lossRate: decided > 0 ? losses / decided : null,
    totalWagered,
    openExposure,
    totalPayout,
    grossPnl,
    fees,
    netPnl,
    roi: ratio(netPnl, totalWagered),
    avgWin: wins > 0 ? winSum / BigInt(wins) : null,
    avgLoss: losses > 0 ? lossSum / BigInt(losses) : null,
    profitFactor: negative === 0n ? null : ratio(positive, -negative),
    expectancy: settledTrades > 0 ? netPnl / BigInt(settledTrades) : null,
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
    currentStreak: { kind: runKind, length: runKind === null ? 0 : run },
    avgStake: stakeCount > 0 ? stakeSum / BigInt(stakeCount) : null,
    maxStake,
    maxDrawdown,
    maxDrawdownPct,
  };
}

function groupBy<K extends string>(
  entries: readonly LedgerEntry[],
  key: (e: LedgerEntry) => K,
): Map<K, LedgerEntry[]> {
  const out = new Map<K, LedgerEntry[]>();
  for (const e of entries) {
    const k = key(e);
    const list = out.get(k);
    if (list) list.push(e);
    else out.set(k, [e]);
  }
  return out;
}

export function utcDay(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function utcMonth(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 7);
}

/** ISO-8601 week, e.g. "2026-W37". */
export function isoWeek(t: number): string {
  const d = new Date(t * 1000);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function periods(events: ReturnType<typeof realizedEvents>, fmt: (t: number) => string): PeriodPnl[] {
  const map = new Map<string, PeriodPnl>();
  for (const { entry, t, net } of events) {
    const key = fmt(t);
    const p = map.get(key) ?? { period: key, netPnl: 0n, trades: 0, wins: 0 };
    p.netPnl += net;
    if (entry.status === 'SETTLED') p.trades++;
    if (entry.result === 'WON') p.wins++;
    map.set(key, p);
  }
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
}

const RETURN_EDGES = [-1, -0.5, 0, 0.5, 1, 1.5, 2, 3];
const STAKE_EDGES_BNB = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];

function histogram(values: number[], edges: number[], fmt: (v: number) => string): Bucket[] {
  const buckets: Bucket[] = [{ label: `< ${fmt(edges[0]!)}`, count: 0 }];
  for (let i = 0; i < edges.length - 1; i++)
    buckets.push({ label: `${fmt(edges[i]!)} – ${fmt(edges[i + 1]!)}`, count: 0 });
  buckets.push({ label: `≥ ${fmt(edges.at(-1)!)}`, count: 0 });
  for (const v of values) {
    let idx = 0;
    while (idx < edges.length && v >= edges[idx]!) idx++;
    buckets[idx]!.count++;
  }
  return buckets;
}

export function computePortfolio(
  entries: readonly LedgerEntry[],
  opts: { startingBankroll?: bigint | null } = {},
): PortfolioReport {
  const start = opts.startingBankroll ?? null;
  const events = realizedEvents(entries);

  const equity: EquityPoint[] = [];
  let cumulative = 0n;
  let peak = start ?? 0n;
  let utilSum = 0;
  let utilCount = 0;
  for (const { entry, t, net } of events) {
    const before = (start ?? 0n) + cumulative;
    if (start !== null && entry.status === 'SETTLED' && before > 0n) {
      utilSum += ratio(entry.amount, before) ?? 0;
      utilCount++;
    }
    cumulative += net;
    const level = (start ?? 0n) + cumulative;
    if (level > peak) peak = level;
    equity.push({
      t,
      epoch: entry.epoch,
      id: entry.id,
      net,
      cumulativePnl: cumulative,
      bankroll: start === null ? null : level,
      drawdown: peak - level,
    });
  }

  const settled = entries.filter((e) => e.status === 'SETTLED');
  const summarize = (list: LedgerEntry[]) => computeSummary(list, null);
  const byDir = groupBy(entries, (e) => e.direction);

  return {
    summary: computeSummary(entries, start),
    byStrategy: Object.fromEntries(
      [...groupBy(entries, (e) => e.strategy ?? 'external')].map(([k, v]) => [k, summarize(v)]),
    ),
    byMarket: Object.fromEntries([...groupBy(entries, (e) => e.market)].map(([k, v]) => [k, summarize(v)])),
    byDirection: { BULL: summarize(byDir.get('BULL') ?? []), BEAR: summarize(byDir.get('BEAR') ?? []) },
    daily: periods(events, utcDay),
    weekly: periods(events, isoWeek),
    monthly: periods(events, utcMonth),
    equity,
    returnsHistogram: histogram(
      settled.filter((e) => e.amount > 0n).map((e) => ratio(tradeNetPnl(e) ?? 0n, e.amount) ?? 0),
      RETURN_EDGES,
      (v) => `${Math.round(v * 100)}%`,
    ),
    stakeHistogram: histogram(
      entries.filter((e) => e.status !== 'FAILED').map((e) => weiToBnb(e.amount)),
      STAKE_EDGES_BNB,
      (v) => `${v}`,
    ),
    capitalUtilization: utilCount > 0 ? utilSum / utilCount : null,
    startingBankroll: start,
  };
}

/** Per-trade running totals for the ledger view, keyed by entry id. */
export function annotateLedger(
  entries: readonly LedgerEntry[],
  startingBankroll: bigint | null,
): Map<number | string, { netPnl: bigint; cumulativePnl: bigint; bankrollAfter: bigint | null }> {
  const out = new Map<
    number | string,
    { netPnl: bigint; cumulativePnl: bigint; bankrollAfter: bigint | null }
  >();
  let cumulative = 0n;
  for (const { entry, net } of realizedEvents(entries)) {
    cumulative += net;
    out.set(entry.id, {
      netPnl: net,
      cumulativePnl: cumulative,
      bankrollAfter: startingBankroll === null ? null : startingBankroll + cumulative,
    });
  }
  return out;
}

/** Keeps at most `max` points (always the first, last and the deepest drawdown point). */
export function downsample<T extends { drawdown: bigint }>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  const stride = Math.ceil(points.length / max);
  let deepest = 0;
  points.forEach((p, i) => {
    if (p.drawdown > points[deepest]!.drawdown) deepest = i;
  });
  const keep = new Set<number>([0, points.length - 1, deepest]);
  for (let i = 0; i < points.length; i += stride) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((i) => points[i]!);
}
