import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { bearer, makeHarness, playRound } from './harness.js';

const PRICES = [600, 601, 602, 601, 600, 601, 603, 602, 604, 603, 605, 606, 604, 607];

describe('research engine', () => {
  it('freezes the specification, records every test in the ledger, and keeps results immutable', async () => {
    const h = await makeHarness();
    for (const p of PRICES) await playRound(h, p * 1e8);
    const { db } = h.app.repos;

    const exp = await h.app.research.register({
      name: 'sequence smoke test',
      spec: { families: ['baseline', 'sequence', 'hour'], trainFraction: 0.5 },
    });
    expect(exp.status).toBe('REGISTERED');
    // Every default is resolved into the stored specification.
    expect(exp.spec).toEqual({
      families: ['baseline', 'sequence', 'hour'],
      fromEpoch: null,
      toEpoch: null,
      trainFraction: 0.5,
      decisionOffsets: [30, 10],
      stakeBnb: '0.01',
      gasBetBnb: '0.00001',
      gasClaimBnb: '0.00001',
      alpha: 0.05,
    });
    await expect(
      db.run('UPDATE research_experiments SET spec = ? WHERE id = ?', ['{}', exp.id]),
    ).rejects.toThrow(/specification cannot change/);

    const done = await h.app.research.run(exp.id);
    expect(done.status).toBe('DONE');
    expect(['NO_EDGE', 'EDGE_CANDIDATE']).toContain(done.verdict);
    expect(done.tests).toHaveLength(done.hypothesesTested!);
    expect(done.dataSummary).toMatchObject({ rounds: expect.any(Number) });
    expect((done.dataSummary as { rounds: number }).rounds).toBeGreaterThan(8);
    expect(await h.app.repos.audit.list({ type: 'RESEARCH_COMPLETED' }, 5)).toHaveLength(1);

    await expect(h.app.research.run(exp.id)).rejects.toThrow(/register a new experiment/);
    await expect(
      db.run("UPDATE research_experiments SET verdict = 'EDGE_CANDIDATE' WHERE id = ?", [exp.id]),
    ).rejects.toThrow(/immutable/);
    await expect(db.run('DELETE FROM research_tests')).rejects.toThrow(/append-only/);
    await expect(db.run('DELETE FROM research_experiments')).rejects.toThrow(/append-only/);

    // A second experiment adds to the ledger; correction then spans both.
    const again = await h.app.research.run(
      (await h.app.research.register({ name: 'repeat', spec: { families: ['sequence'] } })).id,
    );
    const ledger = await h.app.research.ledger();
    expect(ledger.totalTests).toBe(done.hypothesesTested! + again.hypothesesTested!);
    expect(ledger.experiments).toBe(2);
    await h.app.close();
  });

  it('rejects invalid specifications and marks interrupted runs failed', async () => {
    const h = await makeHarness();
    await expect(h.app.research.register({ name: 'x', spec: { families: ['astrology'] } })).rejects.toThrow();
    await expect(h.app.research.register({ name: 'x', spec: { fromEpoch: 10, toEpoch: 5 } })).rejects.toThrow(
      /fromEpoch/,
    );
    await expect(h.app.research.register({ name: 'x', spec: { lookahead: true } })).rejects.toThrow();

    const exp = await h.app.research.register({ name: 'interrupted' });
    expect(await h.app.repos.research.markRunning(exp.id)).toBe(true);
    expect(await h.app.research.failInterrupted()).toBe(1);
    expect((await h.app.repos.research.get(exp.id))!).toMatchObject({
      status: 'FAILED',
      error: 'interrupted by a restart',
    });
    await h.app.close();
  });

  it('registers and runs experiments through the API', async () => {
    const h = await makeHarness();
    for (const p of PRICES.slice(0, 8)) await playRound(h, p * 1e8);
    const server = await buildServer(h.app);
    const bad = await server.inject({
      method: 'POST',
      url: '/api/research/experiments',
      headers: bearer,
      payload: { name: 'bad', spec: { trainFraction: 2 } },
    });
    expect(bad.statusCode).toBe(400);
    const res = await server.inject({
      method: 'POST',
      url: '/api/research/experiments',
      headers: bearer,
      payload: { name: 'api', spec: { families: ['baseline', 'hour'] } },
    });
    expect(res.statusCode).toBe(202);
    const { id } = res.json() as { id: number };
    let view = { status: 'REGISTERED' } as { status: string; tests: unknown[] };
    for (let i = 0; i < 100 && (view.status === 'REGISTERED' || view.status === 'RUNNING'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      view = (
        await server.inject({ method: 'GET', url: `/api/research/experiments/${id}`, headers: bearer })
      ).json();
    }
    expect(view.status).toBe('DONE');
    const list = (
      await server.inject({ method: 'GET', url: '/api/research/experiments', headers: bearer })
    ).json() as {
      id: number;
      result: unknown;
    }[];
    expect(list[0]).toMatchObject({ id, result: null });
    expect(
      (await server.inject({ method: 'GET', url: '/api/research/ledger', headers: bearer })).statusCode,
    ).toBe(200);
    const health = (await server.inject({ method: 'GET', url: '/api/health' })).json() as {
      poolEvents: { enabled: boolean };
    };
    expect(health.poolEvents.enabled).toBe(true);
    await server.close();
    await h.app.close();
  });
});
