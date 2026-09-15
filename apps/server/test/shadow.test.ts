import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Harness } from './harness.js';
import { bearer, makeHarness, playRound, tick } from './harness.js';

async function paperStrategy(h: Harness) {
  await h.app.recovery.run();
  const s = (await h.app.repos.strategies.bySlug('follow-last-winner'))!;
  await h.app.repos.strategies.setFlags(s.id, { enabled: true, paperTradingEnabled: true });
  await h.app.bot.start('test');
}

describe('shadow checks of paper trades', () => {
  it('simulates every paper fill as a live bet and records the verdict (never broadcasting)', async () => {
    const h = await makeHarness();
    await paperStrategy(h);
    for (const p of [600, 601, 602, 603, 604]) await playRound(h, p * 1e8);
    const trades = await h.app.repos.trades.all({ mode: 'PAPER' });
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      const c = (await h.app.repos.shadow.forTrade(t.id))!;
      expect(c).toMatchObject({ outcome: 'ACCEPTED', errorClass: null });
      expect(c.secondsToLock!).toBeGreaterThan(0);
    }
    expect(h.chain.broadcasts).toHaveLength(0);

    const server = await buildServer(h.app);
    const summary = (await server.inject({ method: 'GET', url: '/api/shadow', headers: bearer })).json() as {
      total: number;
      acceptanceRate: number;
    };
    expect(summary).toMatchObject({ total: trades.length, acceptanceRate: 1 });
    const detail = (
      await server.inject({ method: 'GET', url: `/api/trades/${trades[0]!.id}`, headers: bearer })
    ).json() as { shadow: { outcome: string } };
    expect(detail.shadow.outcome).toBe('ACCEPTED');
    await server.close();
    await h.app.close();
  });

  it('records contract rejections and network failures separately', async () => {
    const h = await makeHarness();
    await paperStrategy(h);
    for (const p of [600, 601]) await playRound(h, p * 1e8);

    const decide = async () => {
      const epoch = h.chain.currentEpoch;
      h.chain.setTime(h.chain.round(epoch).lockTime! - 20);
      await tick(h);
      const t = (await h.app.repos.trades.all({ mode: 'PAPER', epoch }))[0]!;
      h.chain.execute(602e8);
      await tick(h);
      return (await h.app.repos.shadow.forTrade(t.id))!;
    };
    h.chain.simulateRevert = 'Bet is too early/late';
    expect(await decide()).toMatchObject({ outcome: 'REJECTED', errorClass: 'CONTRACT_REVERT' });
    expect((await h.app.repos.audit.list({ type: 'SHADOW_REJECTED' }, 5))[0]!.message).toMatch(
      /too early\/late/,
    );

    h.chain.simulateFailures = 1;
    expect(await decide()).toMatchObject({ outcome: 'UNAVAILABLE', errorClass: 'NETWORK' });

    const summary = await h.app.repos.shadow.summary(0);
    expect(summary).toMatchObject({ rejected: 1, unavailable: 1, acceptanceRate: 0 });
    await h.app.close();
  });

  it('can be switched off', async () => {
    const h = await makeHarness({ env: { SHADOW_PREFLIGHT: 'false' } });
    await paperStrategy(h);
    for (const p of [600, 601, 602, 603]) await playRound(h, p * 1e8);
    expect((await h.app.repos.trades.all({ mode: 'PAPER' })).length).toBeGreaterThan(0);
    expect((await h.app.repos.shadow.summary(0)).total).toBe(0);
    await h.app.close();
  });
});
