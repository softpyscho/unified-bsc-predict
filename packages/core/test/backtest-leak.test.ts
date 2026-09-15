/**
 * Look-ahead leak test for every built-in strategy. A decision for round n may only use rounds final at its
 * decision time (≤ n−2) and trades settled by then. So if every round after epoch k is changed, every trade up to
 * epoch k+2 must be identical — for every plugin, under the same pipeline the backtester, paper and live share.
 */
import { describe, expect, it } from 'vitest';
import type { LedgerEntry, RoundOutcome } from '../src/index.js';
import { BUILTIN_STRATEGIES, BacktestRunner, bnbToWei, defaultStrategyConfig, lcg } from '../src/index.js';
import { BUFFER, LOOSE_LIMITS, series } from './fixtures.js';

const N = 400;
const K = 250; // rounds after index K differ between the two histories
const FIRST_EPOCH = 100;

function outcomes(seed: number, n: number): RoundOutcome[] {
  const rand = lcg(seed);
  return Array.from({ length: n }, () => {
    const u = rand();
    return u < 0.47 ? 'BULL' : u < 0.94 ? 'BEAR' : u < 0.97 ? 'TIE' : 'CANCELLED';
  });
}

const base = outcomes(1, N);
const altered = [...base.slice(0, K + 1), ...outcomes(2, N - K - 1)];

function trades(plugin: (typeof BUILTIN_STRATEGIES)[number], history: RoundOutcome[]): LedgerEntry[] {
  const [result] = new BacktestRunner({
    market: 'test',
    rounds: series(history, { firstEpoch: FIRST_EPOCH }),
    strategies: [{ key: plugin.id, plugin, config: defaultStrategyConfig(plugin, 0.01) }],
    startingBankrollWei: bnbToWei(5),
    gasPerBetWei: 0n,
    gasPerClaimWei: 0n,
    treasuryFeeBps: 300,
    minBetWei: bnbToWei('0.001'),
    bufferSeconds: BUFFER,
    globalLimits: LOOSE_LIMITS,
  }).runToEnd();
  return result!.entries;
}

const view = (entries: LedgerEntry[], maxEpoch: number) =>
  entries
    .filter((e) => e.epoch <= maxEpoch)
    .map((e) => ({ epoch: e.epoch, side: e.direction, amount: e.amount.toString() }));

describe('no look-ahead in any built-in strategy', () => {
  it('covers the sequence strategies, including the recovery ladder', () => {
    expect(BUILTIN_STRATEGIES.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        'follow-last-winner',
        'momentum',
        'streak-reversal',
        'sequence-recovery',
        'markov',
      ]),
    );
  });

  const lastSafeEpoch = FIRST_EPOCH + K + 2;
  let divergedSomewhere = 0;

  it.each(BUILTIN_STRATEGIES.map((p) => [p.id, p] as const))(
    '%s: trades up to epoch k+2 do not depend on later rounds',
    (_id, plugin) => {
      const a = trades(plugin, base);
      const b = trades(plugin, altered);
      expect(view(b, lastSafeEpoch)).toEqual(view(a, lastSafeEpoch));
      if (JSON.stringify(view(a, Infinity)) !== JSON.stringify(view(b, Infinity))) divergedSomewhere++;
    },
  );

  it('has the power to detect a difference (later trades do change for some strategies)', () => {
    expect(divergedSomewhere).toBeGreaterThan(0);
  });
});
