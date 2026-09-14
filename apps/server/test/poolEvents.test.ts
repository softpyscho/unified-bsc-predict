import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { BET_BEAR_TOPIC, BET_BULL_TOPIC } from '../src/chain/viem.js';
import { ALICE, BOB, bearer, makeHarness, playRound } from './harness.js';

describe('bet event topics', () => {
  it('match the PancakeSwap Prediction V2 BetBull/BetBear events (as served by BSC nodes)', () => {
    expect(BET_BULL_TOPIC).toBe('0x438122d8cff518d18388099a5181f0d17a12b4f1b55faedf6e4a6acee0060c12');
    expect(BET_BEAR_TOPIC).toBe('0x0d8c1fe3e67ab767116a81f122b83c2557a8c2564019cb7c4f83de1aeb1f1f0d');
  });
});

describe('pool event collector', () => {
  it('backfills, follows the head, and reconstructs every final round exactly', async () => {
    const h = await makeHarness({ env: { POOL_EVENTS_CHUNK_BLOCKS: '200' } });
    const market = h.app.markets.tradable();
    // Bets exist before collection starts: the first run must find them by backfilling.
    for (const p of [600, 601, 602, 603]) await playRound(h, p * 1e8);
    const first = (await h.app.poolEvents.run({ backfillChunks: 100 }))!;
    expect(first).toMatchObject({ inserted: 8, backfillDone: true, caughtUp: true });

    for (const p of [604, 605]) await playRound(h, p * 1e8);
    h.chain.execute(606e8); // ends round 6 so rounds 1-6 are final
    await h.app.monitor.tick();
    expect((await h.app.poolEvents.run())!.inserted).toBe(4);
    expect((await h.app.poolEvents.run())!.inserted).toBe(0); // idempotent

    const checks = await h.app.repos.poolEvents.check(market.id, 1, 6);
    expect(checks).toHaveLength(6);
    expect(checks.every((c) => c.complete && c.events === 2)).toBe(true);

    // Decision-time pools only count blocks strictly before the decision second.
    const events = await h.app.repos.poolEvents.forRound(market.id, 3);
    expect(events.map((e) => e.sender)).toEqual([ALICE, BOB].map((a) => a.toLowerCase()));
    const t = events[0]!.blockTime;
    const r3 = h.chain.round(3);
    expect(await h.app.repos.poolEvents.poolBefore(market.id, 3, t)).toEqual({ bull: 0n, bear: 0n, bets: 0 });
    expect(await h.app.repos.poolEvents.poolBefore(market.id, 3, t + 1)).toEqual({
      bull: r3.bullAmount,
      bear: r3.bearAmount,
      bets: 2,
    });

    const status = await h.app.poolEvents.status();
    expect(status.check).toMatchObject({ fromEpoch: 2, toEpoch: 6, finalRounds: 5, complete: 5 });
    await expect(h.app.repos.db.run('DELETE FROM round_pool_events')).rejects.toThrow(/append-only/);

    const server = await buildServer(h.app);
    const round = (await server.inject({ method: 'GET', url: '/api/rounds/3', headers: bearer })).json() as {
      poolEvents: { amount: string; direction: string }[];
    };
    expect(round.poolEvents.map((e) => e.direction)).toEqual(['BULL', 'BEAR']);
    const api = (await server.inject({ method: 'GET', url: '/api/pool-events', headers: bearer })).json() as {
      summary: { events: number };
    };
    expect(api.summary.events).toBe(12);
    await server.close();
    await h.app.close();
  });

  it('stops backfill where the node has pruned history and flags the rounds it could not reconstruct', async () => {
    const h = await makeHarness({ env: { POOL_EVENTS_CHUNK_BLOCKS: '10' } });
    const market = h.app.markets.tradable();
    for (const p of [600, 601]) await playRound(h, p * 1e8);
    const cut = h.chain.blockNumber;
    await playRound(h, 602e8);
    h.chain.execute(603e8);
    await h.app.monitor.tick();
    // Round 3's bets are ~10 blocks after `cut`; rounds 1-2 are hundreds of blocks before it.
    h.chain.prunedBelow = cut - 50n;

    let last = null;
    for (let i = 0; i < 4; i++) last = await h.app.poolEvents.run({ backfillChunks: 1000 });
    expect(last).toMatchObject({ backfillDone: true, caughtUp: true });
    expect((await h.app.repos.poolEvents.sync(market.id))!.lastError).toMatch(/pruned/);
    expect(await h.app.repos.audit.list({ type: 'POOL_EVENTS_BACKFILL_STOPPED' }, 5)).toHaveLength(1);
    expect((await h.app.repos.poolEvents.check(market.id, 1, 3)).map((c) => c.complete)).toEqual([
      false,
      false,
      true,
    ]);

    await h.app.poolEvents.resetBackfill();
    expect((await h.app.repos.poolEvents.sync(market.id))!.backfillDone).toBe(false);
    await h.app.close();
  });

  it('retries transient log failures and records a gap only after repeated failures', async () => {
    const h = await makeHarness({ env: { POOL_EVENTS_BACKFILL_BLOCKS: '0' } });
    const market = h.app.markets.tradable();
    expect(await h.app.poolEvents.run()).toMatchObject({ inserted: 0, backfillDone: true });

    await playRound(h, 600e8);
    h.chain.logFailures = 1;
    expect(await h.app.poolEvents.run()).toMatchObject({ inserted: 0, caughtUp: false });
    expect(await h.app.poolEvents.run()).toMatchObject({ inserted: 2, caughtUp: true });

    await playRound(h, 601e8);
    h.chain.logFailures = 3;
    await h.app.poolEvents.run();
    await h.app.poolEvents.run();
    expect(await h.app.repos.poolEvents.gaps(market.id)).toHaveLength(0);
    expect(await h.app.poolEvents.run()).toMatchObject({ inserted: 0, caughtUp: true });
    expect(await h.app.repos.poolEvents.gaps(market.id)).toHaveLength(1);
    expect(await h.app.repos.audit.list({ type: 'POOL_EVENTS_GAP' }, 5)).toHaveLength(1);
    await h.app.close();
  });
});
