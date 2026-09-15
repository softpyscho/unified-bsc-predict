import { describe, expect, it } from 'vitest';
import { Db } from '../src/db/database.js';
import { COPY_TABLES, copyDatabase } from '../src/db/copyDb.js';
import { migrate } from '../src/db/migrations.js';
import { createRepos } from '../src/repositories/index.js';
import { makeHarness, playRound } from './harness.js';

describe('copy-db (e.g. embedded PGlite → Supabase)', () => {
  it('copies every table with ids intact and continues the sequences after them', async () => {
    const h = await makeHarness();
    await h.app.recovery.run();
    const s = (await h.app.repos.strategies.bySlug('follow-last-winner'))!;
    await h.app.repos.strategies.setFlags(s.id, { enabled: true, paperTradingEnabled: true });
    await h.app.bot.start('test');
    for (const p of [600, 601, 602, 603, 604, 605]) await playRound(h, p * 1e8);
    await h.app.poolEvents.run({ backfillChunks: 10 });
    const src = h.app.repos.db;

    const target = await Db.open('memory:');
    await migrate(target);
    const copied = await copyDatabase(src, target);
    expect(copied.map((c) => c.table)).toEqual([...COPY_TABLES]);

    for (const table of COPY_TABLES) {
      const count = async (db: Db) => (await db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
      expect(await count(target), table).toBe(await count(src));
    }
    // Spot-check exact values, including wei amounts and JSON.
    const q = 'SELECT id, epoch, bull_amount, bear_amount, outcome FROM rounds ORDER BY id';
    expect(await target.all(q)).toEqual(await src.all(q));
    const t = 'SELECT id, uid, amount, net_pnl, status FROM trades ORDER BY id';
    expect(await target.all(t)).toEqual(await src.all(t));
    expect((await target.get<{ status: string }>('SELECT status FROM bot_state WHERE id = 1'))!.status).toBe(
      'RUNNING',
    );

    // New rows continue after the copied ids.
    const maxAudit = (await src.get<{ m: number }>('SELECT max(id) AS m FROM audit_events'))!.m;
    const next = await createRepos(target).audit.append({
      component: 't',
      severity: 'INFO',
      type: 'X',
      message: 'm',
    });
    expect(next.id).toBeGreaterThan(maxAudit);

    await expect(copyDatabase(src, target)).rejects.toThrow(/already contains data/);
    await target.close();
    await h.app.close();
  });
});
