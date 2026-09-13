import { describe, expect, it } from 'vitest';
import type { LedgerEntry, StrategyPlugin } from '../src/index.js';
import {
  BacktestRunner,
  annotateLedger,
  bnbToWei,
  computePortfolio,
  defaultStrategyConfig,
  downsample,
  followLastWinner,
  isoWeek,
  simulatedPayout,
} from '../src/index.js';
import { BUFFER, LOOSE_LIMITS, series } from './fixtures.js';

const b = (v: string) => bnbToWei(v);

function entry(id: number, over: Partial<LedgerEntry>): LedgerEntry {
  return {
    id,
    mode: 'PAPER',
    epoch: id,
    placedAt: id * 100 - 50,
    settledAt: id * 100,
    strategy: 's1',
    market: 'm',
    direction: 'BULL',
    amount: b('1'),
    status: 'SETTLED',
    result: 'WON',
    payout: null,
    gasCost: b('0.01'),
    claimGasCost: null,
    ...over,
  };
}

const LEDGER: LedgerEntry[] = [
  entry(1, { result: 'WON', payout: b('1.9'), claimGasCost: b('0.01') }), // +0.88
  entry(2, { result: 'LOST', payout: 0n, direction: 'BEAR' }), // -1.01
  entry(3, { result: 'LOST', payout: 0n, amount: b('2'), strategy: 's2' }), // -2.01
  entry(4, { result: 'REFUNDED', payout: b('1'), claimGasCost: b('0.01') }), // -0.02
  entry(5, { result: 'WON', payout: b('2.5'), claimGasCost: b('0.01') }), // +1.48
  entry(6, { status: 'FAILED', result: null, settledAt: null, placedAt: 600, gasCost: b('0.005') }), // -0.005
  entry(7, { status: 'CONFIRMED', result: null, settledAt: null, amount: b('0.5') }), // open
];

describe('portfolio metrics (hand-computed)', () => {
  const report = computePortfolio(LEDGER, { startingBankroll: b('10') });
  const s = report.summary;

  it('counts trades, results and exposure', () => {
    expect(s.settledTrades).toBe(5);
    expect(s.failedTrades).toBe(1);
    expect(s.openTrades).toBe(1);
    expect(s.openExposure).toBe(b('0.5'));
    expect([s.wins, s.losses, s.refunds]).toEqual([2, 2, 1]);
    expect(s.winRate).toBe(0.5);
    expect(s.lossRate).toBe(0.5);
  });

  it('computes money figures exactly', () => {
    expect(s.totalWagered).toBe(b('6'));
    expect(s.totalPayout).toBe(b('5.4'));
    expect(s.grossPnl).toBe(-b('0.6'));
    expect(s.fees).toBe(b('0.085'));
    expect(s.netPnl).toBe(-b('0.685'));
    expect(s.roi).toBeCloseTo(-0.685 / 6, 10);
    expect(s.avgWin).toBe(b('1.18'));
    expect(s.avgLoss).toBe(-b('1.51'));
    expect(s.profitFactor).toBeCloseTo(2.36 / 3.04, 10);
    expect(s.expectancy).toBe(-b('0.137'));
    expect(s.maxStake).toBe(b('2'));
    expect(s.avgStake).toBe(b('6.5') / 6n);
  });

  it('computes streaks and drawdown', () => {
    expect(s.longestWinStreak).toBe(1);
    expect(s.longestLossStreak).toBe(2);
    expect(s.currentStreak).toEqual({ kind: 'WIN', length: 1 });
    expect(s.maxDrawdown).toBe(b('3.04'));
    expect(s.maxDrawdownPct).toBeCloseTo(3.04 / 10.88, 10);
  });

  it('builds a consistent equity curve, periods and breakdowns', () => {
    expect(report.equity.map((p) => p.cumulativePnl)).toEqual([
      b('0.88'),
      -b('0.13'),
      -b('2.14'),
      -b('2.16'),
      -b('0.68'),
      -b('0.685'),
    ]);
    expect(report.equity.at(-1)!.bankroll).toBe(b('9.315'));
    expect(report.daily).toEqual([{ period: '1970-01-01', netPnl: -b('0.685'), trades: 5, wins: 2 }]);
    expect(report.byStrategy.s2!.netPnl).toBe(-b('2.01'));
    expect(report.byDirection.BEAR.losses).toBe(1);
    expect(report.returnsHistogram.reduce((a, x) => a + x.count, 0)).toBe(5);
    const annotated = annotateLedger(LEDGER, b('10'));
    expect(annotated.get(3)).toEqual({
      netPnl: -b('2.01'),
      cumulativePnl: -b('2.14'),
      bankrollAfter: b('7.86'),
    });
    expect(annotated.has(7)).toBe(false);
  });

  it('is deterministic regardless of input order', () => {
    const shuffled = [...LEDGER].reverse();
    expect(computePortfolio(shuffled, { startingBankroll: b('10') }).summary).toEqual(s);
  });

  it('formats ISO weeks', () => {
    expect(isoWeek(Date.UTC(2026, 0, 1) / 1000)).toBe('2026-W01');
    expect(isoWeek(Date.UTC(2027, 0, 1) / 1000)).toBe('2026-W53');
  });

  it('downsamples but keeps the extremes', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ i, drawdown: i === 537 ? 99n : 0n }));
    const out = downsample(pts, 100);
    expect(out.length).toBeLessThanOrEqual(103);
    expect(out[0]!.i).toBe(0);
    expect(out.at(-1)!.i).toBe(999);
    expect(out.some((p) => p.i === 537)).toBe(true);
  });
});

describe('backtest runner', () => {
  const plugin = followLastWinner as StrategyPlugin;
  const alternating = series(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'BULL' : 'BEAR')));

  function runner(limits = LOOSE_LIMITS, rounds = alternating) {
    return new BacktestRunner({
      market: 'test',
      rounds,
      strategies: [{ key: 'flw', plugin, config: defaultStrategyConfig(plugin, 0.01) }],
      startingBankrollWei: b('1'),
      gasPerBetWei: 0n,
      gasPerClaimWei: 0n,
      treasuryFeeBps: 300,
      minBetWei: b('0.001'),
      bufferSeconds: BUFFER,
      globalLimits: limits,
    });
  }

  it('only sees round n-2 when deciding round n (no look-ahead)', () => {
    // With alternating outcomes, outcome(n) == outcome(n-2): following the last *known* winner always wins.
    // Any leak of round n-1 would make it always lose instead.
    const [result] = runner().runToEnd();
    const summary = result!.report.summary;
    expect(summary.settledTrades).toBe(38);
    expect(summary.wins).toBe(38);
    expect(result!.decisions.reasons).toEqual({ STRATEGY_SKIP: 2 });
    const perTrade =
      simulatedPayout({ bullAmount: b('1'), bearAmount: b('1') }, 'BULL', 'BULL', b('0.01'), 300) - b('0.01');
    expect(summary.netPnl).toBe(perTrade * 38n);
  });

  it('keeps the previous trade at risk while deciding the next round', () => {
    const [result] = runner({ ...LOOSE_LIMITS, maxExposureWei: b('0.015') }).runToEnd();
    expect(result!.decisions.trades).toBe(19);
    expect(result!.decisions.reasons['RISK_REJECTED:MAX_EXPOSURE']).toBe(19);
  });

  it('balances the books: final bankroll = start + net P&L', () => {
    const rounds = series([
      'BULL',
      'BEAR',
      'BEAR',
      'TIE',
      'BULL',
      'CANCELLED',
      'BULL',
      'BULL',
      'BEAR',
      'BULL',
      'BULL',
      'BULL',
    ]);
    const r = new BacktestRunner({
      market: 'test',
      rounds,
      strategies: [{ key: 'flw', plugin, config: defaultStrategyConfig(plugin, 0.05) }],
      startingBankrollWei: b('1'),
      gasPerBetWei: b('0.0001'),
      gasPerClaimWei: b('0.0002'),
      treasuryFeeBps: 300,
      minBetWei: b('0.001'),
      bufferSeconds: BUFFER,
      globalLimits: LOOSE_LIMITS,
    }).runToEnd()[0]!;
    const last = r.report.equity.at(-1)!;
    expect(last.bankroll).toBe(b('1') + r.report.summary.netPnl);
    expect(r.report.summary.openTrades).toBe(0);
    expect(r.entries.every((e) => e.status === 'SETTLED')).toBe(true);
    // Deterministic across runs.
    const again = runner(LOOSE_LIMITS, rounds).runToEnd()[0]!;
    const twice = runner(LOOSE_LIMITS, rounds).runToEnd()[0]!;
    expect(again.report.summary).toEqual(twice.report.summary);
  });

  it('can be stepped incrementally', () => {
    const r = runner();
    r.step(10);
    expect(r.processed).toBe(10);
    expect(r.done).toBe(false);
    while (!r.done) r.step(7);
    expect(r.results()[0]!.report.summary.settledTrades).toBe(38);
  });
});
