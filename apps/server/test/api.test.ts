import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { TOKEN, bearer, makeHarness, playRound } from './harness.js';

async function setup(live = false) {
  const h = await makeHarness({ live });
  if (live) h.chain.fund(h.app.config.walletAddress!, 10n ** 18n);
  await h.app.recovery.run();
  const server = await buildServer(h.app);
  return { h, server };
}

describe('API', () => {
  it('requires authentication except for health', async () => {
    const { h, server } = await setup();
    const health = await server.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ database: 'ok', bot: { status: 'STOPPED' } });
    expect((await server.inject({ method: 'GET', url: '/api/overview' })).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/overview',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/api/overview', headers: bearer })).statusCode).toBe(
      200,
    );
    await server.close();
    await h.app.close();
  });

  it('exchanges the token for an HttpOnly session cookie and rate-limits guessing', async () => {
    const { h, server } = await setup();
    const bad = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const ok = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TOKEN } });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.headers['set-cookie'] as string;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const session = cookie.split(';')[0]!;
    expect(
      (await server.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session } })).statusCode,
    ).toBe(200);
    for (let i = 0; i < 10; i++)
      await server.inject({ method: 'POST', url: '/api/auth/login', payload: { token: `x${i}` } });
    expect(
      (await server.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TOKEN } })).statusCode,
    ).toBe(429);
    await server.close();
    await h.app.close();
  });

  it('rejects cross-origin mutations and invalid input', async () => {
    const { h, server } = await setup();
    const cross = await server.inject({
      method: 'POST',
      url: '/api/bot/start',
      headers: { ...bearer, origin: 'https://evil.example', host: 'localhost:8080' },
      payload: {},
    });
    expect(cross.statusCode).toBe(403);
    expect(
      (await server.inject({ method: 'GET', url: '/api/trades?limit=9999', headers: bearer })).statusCode,
    ).toBe(400);
    const s = (await h.app.repos.strategies.bySlug('momentum'))!;
    const bad = await server.inject({
      method: 'PATCH',
      url: `/api/strategies/${s.id}`,
      headers: bearer,
      payload: { config: { params: { window: 1 } } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/window/);
    await server.close();
    await h.app.close();
  });

  it('controls the bot lifecycle and records it in the audit log', async () => {
    const { h, server } = await setup();
    const post = (url: string, payload: unknown = {}) =>
      server.inject({ method: 'POST', url, headers: bearer, payload: payload as object });
    expect((await post('/api/bot/start')).json().status).toBe('RUNNING');
    expect((await post('/api/bot/pause')).json().status).toBe('PAUSED');
    expect((await post('/api/bot/resume')).json().status).toBe('RUNNING');
    expect((await post('/api/bot/emergency-stop', { reason: 'test' })).json().status).toBe(
      'EMERGENCY_STOPPED',
    );
    expect((await post('/api/bot/start')).statusCode).toBe(409);
    expect((await post('/api/bot/reset', { acknowledge: true })).json().status).toBe('STOPPED');
    expect((await post('/api/bot/live/arm', { confirmation: 'ENABLE LIVE TRADING' })).statusCode).toBe(409); // env flag off
    const logs = (
      await server.inject({ method: 'GET', url: '/api/logs?limit=50', headers: bearer })
    ).json() as { type: string }[];
    for (const t of ['BOT_STARTED', 'BOT_PAUSED', 'BOT_RESUMED', 'EMERGENCY_STOP', 'EMERGENCY_RESET'])
      expect(logs.map((l) => l.type)).toContain(t);
    await server.close();
    await h.app.close();
  });

  it('requires the exact confirmation phrase to arm live trading', async () => {
    const { h, server } = await setup(true);
    const arm = (confirmation: string) =>
      server.inject({ method: 'POST', url: '/api/bot/live/arm', headers: bearer, payload: { confirmation } });
    expect((await arm('yes')).statusCode).toBe(409);
    expect((await arm('ENABLE LIVE TRADING')).json().liveArmed).toBe(true);
    await server.close();
    await h.app.close();
  });

  it('never returns secrets', async () => {
    const { h, server } = await setup(true);
    const key = h.privateKey!.slice(2).toLowerCase();
    for (const url of ['/api/settings', '/api/bot/status', '/api/wallet', '/api/overview', '/api/logs']) {
      const body = (await server.inject({ method: 'GET', url, headers: bearer })).body.toLowerCase();
      expect(body).not.toContain(key);
      expect(body).not.toContain(TOKEN.toLowerCase());
    }
    await server.close();
    await h.app.close();
  });

  it('reports the database engine and size in settings', async () => {
    const { h, server } = await setup();
    const settings = (
      await server.inject({ method: 'GET', url: '/api/settings', headers: bearer })
    ).json() as {
      database: { engine: string; sizeBytes: number | null; markets: { slug: string; total: number }[] };
    };
    expect(settings.database.engine).toBe('pglite');
    expect(settings.database.sizeBytes).toBeGreaterThan(0);
    expect(settings.database.markets.length).toBeGreaterThan(0);
    await server.close();
    await h.app.close();
  });

  it('places manual paper orders through the risk pipeline', async () => {
    const { h, server } = await setup();
    await playRound(h, 600e8);
    const round = h.chain.round(h.chain.currentEpoch);
    h.chain.setTime(round.lockTime! - 60);
    await h.app.monitor.tick();
    const res = await server.inject({
      method: 'POST',
      url: '/api/trades/manual',
      headers: bearer,
      payload: { mode: 'PAPER', direction: 'BEAR', amountBnb: '0.005' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      decision: { decision: string };
      trade: { direction: string; amount: string; source: string };
    };
    expect(body.decision.decision).toBe('TRADE');
    expect(body.trade).toMatchObject({ direction: 'BEAR', amount: '5000000000000000', source: 'MANUAL' });
    const again = await server.inject({
      method: 'POST',
      url: '/api/trades/manual',
      headers: bearer,
      payload: { mode: 'PAPER', direction: 'BULL', amountBnb: '0.005' },
    });
    expect(again.statusCode).toBe(409);
    const tooBig = await server.inject({
      method: 'POST',
      url: '/api/trades/manual',
      headers: bearer,
      payload: { mode: 'LIVE', direction: 'BULL', amountBnb: '1' },
    });
    expect(tooBig.json().decision.decision).toBe('NO_TRADE');
    await server.close();
    await h.app.close();
  });

  it('streams server-sent events', async () => {
    const { h, server } = await setup();
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as { port: number }).port;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: bearer, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^event: hello/);
    await h.app.bot.start('sse-test');
    let seen = '';
    for (let i = 0; i < 5 && !seen.includes('event: bot'); i++)
      seen += new TextDecoder().decode((await reader.read()).value);
    expect(seen).toContain('event: bot');
    ctrl.abort();
    await server.close();
    await h.app.close();
  });

  it('runs a backtest over stored rounds', async () => {
    const { h, server } = await setup();
    for (const p of [600, 601, 602, 601, 600, 601, 603, 602, 604, 603, 605, 606]) await playRound(h, p * 1e8);
    const s = (await h.app.repos.strategies.bySlug('follow-last-winner'))!;
    const start = await server.inject({
      method: 'POST',
      url: '/api/backtest',
      headers: bearer,
      payload: {
        from: 1,
        to: 2_000_000_000,
        strategies: [{ strategyId: s.id }, { plugin: 'streak-reversal', config: { params: { streak: 2 } } }],
      },
    });
    expect(start.statusCode).toBe(202);
    const { id } = start.json() as { id: number };
    let run = { status: 'RUNNING' } as {
      status: string;
      result: { rounds: number; results: { key: string; summary: { settledTrades: number } }[] };
    };
    for (let i = 0; i < 200 && run.status === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      run = (await server.inject({ method: 'GET', url: `/api/backtest/${id}`, headers: bearer })).json();
    }
    expect(run.status).toBe('DONE');
    expect(run.result.results.map((r) => r.key)).toEqual(['follow-last-winner', 'streak-reversal']);
    expect(run.result.results[0]!.summary.settledTrades).toBeGreaterThan(0);
    await server.close();
    await h.app.close();
  });
});
