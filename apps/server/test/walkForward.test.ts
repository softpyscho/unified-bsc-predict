import { describe, expect, it } from 'vitest';
import { makeHarness, playRound } from './harness.js';

const PRICES = [600, 601, 602, 601, 600, 601, 603, 602, 604, 603, 605, 606, 604, 607, 606, 608, 607, 609];

describe('walk-forward backtests', () => {
  it('tunes one strategy per fold and reports the out-of-sample record', async () => {
    const h = await makeHarness();
    for (const p of PRICES) await playRound(h, p * 1e8);
    await expect(
      h.app.backtests.start({
        from: 1,
        to: 2_000_000_000,
        strategies: [{ plugin: 'streak-reversal' }, { plugin: 'momentum' }],
        walkForward: { trainRounds: 10, testRounds: 2 },
      }),
    ).rejects.toThrow(/exactly one strategy/);
    await expect(
      h.app.backtests.start({
        from: 1,
        to: 2_000_000_000,
        strategies: [{ plugin: 'streak-reversal' }],
        walkForward: { trainRounds: 10, testRounds: 2, stepRounds: 1 },
      }),
    ).rejects.toThrow(/overlap/);

    const id = await h.app.backtests.start({
      from: 1,
      to: 2_000_000_000,
      strategies: [{ plugin: 'streak-reversal' }],
      walkForward: { trainRounds: 10, testRounds: 2, grid: { streak: [2, 3] } },
    });
    let run = (await h.app.repos.backtests.get(id))!;
    for (let i = 0; i < 200 && run.status === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      run = (await h.app.repos.backtests.get(id))!;
    }
    expect(run.status).toBe('DONE');
    const result = run.result as {
      walkForward: { candidates: { streak: number }[]; folds: { chosen: { streak: number } }[] };
      results: { key: string; summary: { settledTrades: number } }[];
    };
    expect(result.walkForward.candidates.map((c) => c.streak)).toEqual([2, 3]);
    expect(result.walkForward.folds.length).toBeGreaterThan(0);
    expect(result.walkForward.folds.every((f) => [2, 3].includes(f.chosen.streak))).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.key).toBe('streak-reversal (walk-forward, out of sample)');
    await h.app.close();
  });
});
