import type { ResearchRound } from '@bsc/core';
import { lcg, runStudy } from '@bsc/core';
import { describe, expect, it } from 'vitest';
import {
  allocEventColumns,
  allocRoundColumns,
  decodeEvents,
  decodeRounds,
  setEvent,
  setRound,
} from '../src/research/columns.js';
import { runStudyJob } from '../src/research/runner.js';

const cost = { stakeWei: 10n ** 16n, gasBetWei: 10n ** 13n, gasClaimWei: 10n ** 13n };

function sample(n: number): ResearchRound[] {
  const rand = lcg(11);
  return Array.from({ length: n }, (_, i) => {
    const bull = BigInt(Math.floor(rand() * 1e9)) * 10n ** 12n + 123n;
    const bear = BigInt(Math.floor(rand() * 1e9)) * 10n ** 12n + 7n;
    const outcome = rand() < 0.5 ? ('BULL' as const) : ('BEAR' as const);
    return {
      epoch: i + 1,
      lockTime: 1_700_000_000 + i * 300,
      total: bull + bear,
      bull,
      bear,
      reward: ((bull + bear) * 97n) / 100n,
      rewardBase: outcome === 'BULL' ? bull : bear,
      outcome,
      feeBps: 300,
    };
  });
}

function encode(rounds: readonly ResearchRound[]) {
  const cols = allocRoundColumns(rounds.length, 300);
  rounds.forEach((r, i) => setRound(cols, i, r));
  return cols;
}

describe('research worker transport', () => {
  it('round-trips wei amounts exactly, including values far beyond 2^53 and 2^64', () => {
    const big = [0n, 1n, 2n ** 53n + 1n, 2n ** 64n + 12345n, 10n ** 24n + 987654321n, 2n ** 103n + 1n];
    const rounds = big.map((v, i) => ({
      ...sample(1)[0]!,
      epoch: i + 1,
      total: v,
      bull: v,
      bear: v / 3n,
      reward: v / 7n,
      rewardBase: v / 11n,
      outcome: (['BULL', 'BEAR', 'TIE', 'CANCELLED'] as const)[i % 4]!,
    }));
    expect(decodeRounds(encode(rounds))).toEqual(rounds);

    const events = allocEventColumns(big.length);
    big.forEach((amount, i) =>
      setEvent(events, i, { epoch: 7, time: 100 + i, side: i % 2 ? 'BEAR' : 'BULL', amount }),
    );
    expect(
      decodeEvents(events)
        .get(7)!
        .map((e) => e.amount),
    ).toEqual(big);
  });

  it('gives the same result on a worker thread as inline', async () => {
    const rounds = sample(3000);
    const options = { cost, families: ['baseline', 'sequence', 'hour'] as const };
    const inline = runStudy(rounds, { ...options, families: [...options.families] });
    const threaded = await runStudyJob(
      { rounds: encode(rounds), events: null, options: { ...options, families: [...options.families] } },
      // The source worker, loaded through tsx (the built server uses dist/researchWorker.js).
      { worker: new URL('../src/research/worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] },
    );
    expect(threaded).toEqual(inline);
  });
});
