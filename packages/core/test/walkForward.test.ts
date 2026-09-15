import { describe, expect, it } from 'vitest';
import type { RoundOutcome, StrategyPlugin } from '../src/index.js';
import { WalkForwardRunner, bnbToWei, defaultStrategyConfig, expandGrid } from '../src/index.js';
import { BUFFER, LOOSE_LIMITS, series } from './fixtures.js';

/** Always backs one side; the parameter is what walk-forward tunes. */
const sidePlugin: StrategyPlugin = {
  id: 'toy-side',
  name: 'Toy side',
  version: '1',
  description: 'always bets one side',
  params: [
    { key: 'side', label: 'Side', type: 'enum', description: 'side to back', options: ['BULL', 'BEAR'] },
  ],
  defaults: { side: 'BULL' },
  lookback: () => 1,
  evaluate: (_ctx, p) => ({
    action: p.side === 'BULL' ? 'BUY_UP' : 'BUY_DOWN',
    confidence: 0.5,
    rationale: `always ${String(p.side)}`,
  }),
};

/** Regimes of 60 rounds: all BULL, then all BEAR, and so on. */
const REGIMES: RoundOutcome[] = Array.from({ length: 240 }, (_, i) =>
  Math.floor(i / 60) % 2 === 0 ? 'BULL' : 'BEAR',
);

function wf(
  outcomes: RoundOutcome[],
  over: Partial<ConstructorParameters<typeof WalkForwardRunner>[0]> = {},
) {
  return new WalkForwardRunner({
    market: 'test',
    rounds: series(outcomes),
    plugin: sidePlugin,
    base: defaultStrategyConfig(sidePlugin, 0.01),
    grid: { side: ['BULL', 'BEAR'] },
    trainRounds: 30,
    testRounds: 10,
    startingBankrollWei: bnbToWei(5),
    gasPerBetWei: 0n,
    gasPerClaimWei: 0n,
    treasuryFeeBps: 300,
    minBetWei: bnbToWei('0.001'),
    bufferSeconds: BUFFER,
    globalLimits: LOOSE_LIMITS,
    ...over,
  });
}

describe('walk-forward validation', () => {
  it('expands a parameter grid over the base configuration', () => {
    expect(expandGrid({ a: 1, b: 'x', c: true }, { a: [1, 2], b: ['x', 'y'], d: [] })).toEqual([
      { a: 1, b: 'x', c: true },
      { a: 1, b: 'y', c: true },
      { a: 2, b: 'x', c: true },
      { a: 2, b: 'y', c: true },
    ]);
  });

  it('chooses each fold’s candidate from its training window only and trades it on the unseen test window', () => {
    const runner = wf(REGIMES);
    expect(runner.foldCount).toBe(21);
    const res = runner.runToEnd();
    for (const f of res.folds) {
      const i = f.trainFromEpoch - 100;
      const window = REGIMES.slice(i, i + 30);
      const bull = window.filter((o) => o === 'BULL').length;
      expect(f.chosen.side).toBe(bull >= 30 - bull ? 'BULL' : 'BEAR');
      expect(f.testFromEpoch).toBe(f.trainToEpoch + 1);
      expect(f.train.settledTrades).toBe(30);
      expect(f.test.settledTrades).toBe(10);
    }
    // Test windows are back to back and never overlap; the combined record is their exact sum.
    expect(res.folds.slice(1).every((f, k) => f.testFromEpoch === res.folds[k]!.testToEpoch + 1)).toBe(true);
    expect(res.outOfSample.summary.settledTrades).toBe(21 * 10);
    expect(res.outOfSample.summary.netPnl).toBe(res.folds.reduce((a, f) => a + f.test.netPnl, 0n));
    // Persistent regimes: the tuned choice wins out of sample, and mostly stays put between folds.
    expect(res.outOfSample.summary.netPnl).toBeGreaterThan(0n);
    expect(res.selectionStability!).toBeGreaterThan(0.7);
  });

  it('is not influenced by the test window it is about to trade', () => {
    const flipped = [...REGIMES];
    for (let i = 30; i < 40; i++) flipped[i] = 'BEAR'; // fold 0's test window
    const a = wf(REGIMES).runToEnd().folds[0]!;
    const b = wf(flipped).runToEnd().folds[0]!;
    expect(b.chosenIndex).toBe(a.chosenIndex);
    expect(b.train).toEqual(a.train);
    expect(b.test.netPnl).not.toBe(a.test.netPnl);
  });

  it('supports an anchored (expanding) training window', () => {
    const res = wf(REGIMES, { anchored: true }).runToEnd();
    expect(res.folds.every((f) => f.trainFromEpoch === 100)).toBe(true);
    expect(res.folds.at(-1)!.train.settledTrades).toBe(230);
  });

  it('rejects overlapping test windows, too little data and invalid candidates', () => {
    expect(() => wf(REGIMES, { stepRounds: 5 })).toThrow(/overlap/);
    expect(() => wf(REGIMES.slice(0, 35))).toThrow(/not enough for one fold/);
    expect(() => wf(REGIMES, { grid: { side: ['BULL', 'SIDEWAYS'] } })).toThrow(/candidate 2/);
  });
});
