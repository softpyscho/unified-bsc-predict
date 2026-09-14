import { describe, expect, it } from 'vitest';
import type { ResearchPoolEvent, ResearchRound } from '../src/index.js';
import { lcg, poolBefore, runStudy, summarizeBets } from '../src/index.js';

const ONE = 10n ** 18n;
const cost = { stakeWei: 10n ** 16n, gasBetWei: 10n ** 13n, gasClaimWei: 10n ** 13n };

function round(epoch: number, outcome: ResearchRound['outcome'], bull = ONE, bear = ONE): ResearchRound {
  const total = bull + bear;
  return {
    epoch,
    lockTime: 1_700_000_000 + epoch * 300,
    total,
    bull,
    bear,
    reward: (total * 9700n) / 10_000n,
    rewardBase: outcome === 'BULL' ? bull : outcome === 'BEAR' ? bear : 0n,
    outcome,
    feeBps: 300,
  };
}

describe('research: bet evaluation', () => {
  it('charges the fee, own-stake dilution and gas', () => {
    const s = summarizeBets(
      [
        { r: round(1, 'BULL'), side: 'BULL' },
        { r: round(2, 'BULL'), side: 'BEAR' },
      ],
      cost,
    );
    expect(s.bets).toBe(2);
    expect(s.hitRate).toBe(0.5);
    // Win: 0.01 × (2.01 × 0.97) / 1.01 = 0.0193049… BNB, i.e. a multiplier below the naive 1.94.
    expect(s.meanWinMultiplier).toBeCloseTo((2.01 * 0.97) / 1.01, 4);
    expect(s.roi!).toBeLessThan(0);
    expect(s.breakEven!).toBeGreaterThan(0.5);
  });

  it('counts only bets in blocks strictly before the decision second', () => {
    const events: ResearchPoolEvent[] = [
      { time: 99, side: 'BEAR', amount: 2n },
      { time: 100, side: 'BULL', amount: 1n },
    ];
    expect(poolBefore(events, 100)).toEqual({ bull: 0n, bear: 2n, bets: 1 });
    expect(poolBefore(events, 101)).toEqual({ bull: 1n, bear: 2n, bets: 2 });
  });
});

describe('research: studies', () => {
  it('finds a planted, tradable pattern (outcomes alternate, so round n repeats round n−2)', () => {
    const rounds = Array.from({ length: 4000 }, (_, i) => round(i + 1, i % 2 ? 'BULL' : 'BEAR'));
    const res = runStudy(rounds, { cost, families: ['sequence'] });
    expect(res.verdict).toBe('EDGE_CANDIDATE');
    expect(res.survivors.map((h) => h.id)).toContain('seq-lag2-U');
    const rule = res.rules.find((r) => r.name === 'sequence U → BULL')!;
    expect(rule.edge).toBe(true);
    expect(rule.stats.hitRate).toBe(1);
  });

  it('reports no edge on fair coin flips, however many rules are searched', () => {
    const rand = lcg(1);
    const rounds = Array.from({ length: 20_000 }, (_, i) => round(i + 1, rand() < 0.5 ? 'BULL' : 'BEAR'));
    const res = runStudy(rounds, { cost, families: ['baseline', 'sequence', 'hour'] });
    expect(res.rules.length).toBeGreaterThan(40);
    expect(res.verdict).toBe('NO_EDGE');
    expect(res.edges).toHaveLength(0);
    // Playing costs the fee: the random control loses about 3.5% per bet at these pools.
    expect(res.controls.random.roi!).toBeLessThan(-0.02);
    expect(res.breakEvenHitRate!).toBeGreaterThan(0.5);
  });

  it('uses only rounds whose pool events reconstruct the final pools exactly', () => {
    const rand = lcg(3);
    const rounds: ResearchRound[] = [];
    const events = new Map<number, ResearchPoolEvent[]>();
    for (let i = 1; i <= 200; i++) {
      const bull = ONE + BigInt(Math.floor(rand() * 1e6)) * 10n ** 12n;
      const r = round(i, rand() < 0.5 ? 'BULL' : 'BEAR', bull, ONE);
      rounds.push(r);
      const evs: ResearchPoolEvent[] = [
        { time: r.lockTime - 200, side: 'BULL', amount: bull },
        { time: r.lockTime - 5, side: 'BEAR', amount: ONE },
      ];
      if (i % 5 === 0) evs.pop(); // a missing log: this round must be excluded
      events.set(i, evs);
    }
    const res = runStudy(rounds, { cost, families: ['pool'], decisionOffsets: [30] }, events);
    expect(res.pools!.candidates).toBe(200);
    expect(res.pools!.sampleRounds).toBe(160);
    // At T−30s only the early BULL money is visible: 100% of the late flow is the BEAR bet.
    expect(res.pools!.perOffset[0]!.lateFlow.mean).toBeGreaterThan(0.3);
  });
});
