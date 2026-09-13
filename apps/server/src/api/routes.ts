import type { TradeMode } from '@bsc/core';
import {
  BUILTIN_STRATEGIES,
  annotateLedger,
  bnbToWei,
  computeSummary,
  getPlugin,
  manualOrder,
  parseStrategyConfig,
} from '@bsc/core';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import type { App } from '../app.js';
import { publicConfig } from '../config.js';
import type { Trade } from '../repositories/index.js';
import type { TradeFilter } from '../repositories/trades.js';
import { AuditType } from '../services/audit.js';
import { errorMessage } from '../util/json.js';
import type { Sessions } from './auth.js';
import { SESSION_COOKIE } from './auth.js';

const int = z.coerce.number().int();
/** Dashboard market statistics may be this stale (they change by one round per interval). */
const STATS_MAX_AGE_MS = 30_000;
const page = z.object({
  limit: int.min(1).max(500).default(50),
  offset: int.min(0).default(0),
});
const modeSchema = z.enum(['PAPER', 'LIVE']);
const idParam = z.object({ id: int.positive() });
const reasonBody = z.object({ reason: z.string().max(200).optional() }).default({});
const bnbString = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return bnbToWei(typeof v === 'number' ? v : v.trim());
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid BNB amount' });
    return z.NEVER;
  }
});

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

export function registerRoutes(server: FastifyInstance, app: App, sessions: Sessions): void {
  const { repos, config } = app;
  const tradable = () => app.markets.tradable();
  const strategySlugs = () => new Map(repos.strategies.list().map((s) => [s.id, s.slug]));

  const modeOverview = (mode: TradeMode) => {
    const signer = repos.wallets.signer();
    if (mode === 'LIVE' && !signer)
      return {
        account: app.portfolio.liveAccount(),
        summary: computeSummary([]),
        todayPnl: 0n,
        todayTrades: 0,
      };
    const trades = repos.trades.all({ mode, walletId: mode === 'LIVE' ? signer!.id : undefined });
    const account = mode === 'PAPER' ? app.portfolio.paperAccount() : app.portfolio.liveAccount(signer!.id);
    const entries = app.portfolio.toEntries(trades);
    const dayStart = utcDayStart(app.ctx.clock.nowMs());
    let todayPnl = 0n;
    let todayTrades = 0;
    for (const t of trades) {
      if (t.status === 'SETTLED' && (t.settledAt ?? 0) >= dayStart) {
        todayPnl += t.netPnl ?? 0n;
        todayTrades++;
      }
    }
    return { account, summary: computeSummary(entries, account.startingBankroll), todayPnl, todayTrades };
  };

  // ------------------------------------------------------------------------------------------------ system

  server.get('/api/health', async () => {
    const state = app.monitor.state;
    const bot = app.bot.view();
    let db = 'ok';
    try {
      repos.db.get('SELECT 1');
    } catch {
      db = 'error';
    }
    const chainOk = state !== null && !state.stale;
    return {
      status: db === 'ok' && chainOk ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      database: db,
      chain: {
        ok: chainOk,
        lastSnapshotAgeSeconds: state
          ? Math.round((app.ctx.clock.nowMs() - state.observedAtMs) / 1000)
          : null,
        currentEpoch: state?.currentEpoch ?? null,
        lastError: state?.lastError ?? null,
      },
      bot: { status: bot.status, phase: bot.phase },
      workerLoops: app.worker.loopsRunning,
    };
  });

  server.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    if (sessions.isRateLimited(ip))
      return reply.code(429).send({ error: 'too many attempts; try again later' });
    const body = z.object({ token: z.string().min(1).max(512) }).parse(req.body);
    if (!sessions.verifyToken(body.token)) {
      sessions.recordFailure(ip);
      app.audit.record({
        component: 'api',
        severity: 'WARN',
        type: AuditType.AUTH_FAILED,
        message: `failed login from ${ip}`,
      });
      return reply.code(401).send({ error: 'invalid token' });
    }
    sessions.clearFailures(ip);
    reply.setCookie(SESSION_COOKIE, sessions.create(), {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: 12 * 60 * 60,
    });
    return { ok: true };
  });

  server.post('/api/auth/logout', async (req, reply) => {
    sessions.revoke(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  server.get('/api/auth/me', async () => ({ authenticated: true }));

  server.get('/api/overview', async () => {
    const slugs = strategySlugs();
    const latestTrades = repos.trades.list({}, { limit: 10, offset: 0, order: 'desc' }).rows.map((t) => ({
      ...t,
      strategySlug: t.strategyId === null ? null : (slugs.get(t.strategyId) ?? null),
    }));
    const latestDecisions = repos.decisions
      .list({}, { limit: 10, offset: 0 })
      .rows.map((d) => ({ ...d, strategySlug: slugs.get(d.strategyId) ?? null }));
    const alerts = [
      ...repos.audit.list({ severity: 'CRITICAL' }, 5),
      ...repos.audit.list({ severity: 'ERROR' }, 10),
      ...repos.audit.list({ severity: 'WARN' }, 10),
    ]
      .sort((a, b) => b.id - a.id)
      .slice(0, 10);
    return {
      market: app.monitor.state,
      bot: app.bot.view(),
      paper: modeOverview('PAPER'),
      live: modeOverview('LIVE'),
      latestTrades,
      latestDecisions,
      alerts,
      activeStrategies: repos.strategies
        .list()
        .filter((s) => s.enabled && s.plugin !== manualOrder.id)
        .map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          paper: s.paperTradingEnabled,
          live: s.liveTradingEnabled,
        })),
    };
  });

  server.get('/api/settings', async () => {
    let dbSize: number | null = null;
    if (config.databasePath !== ':memory:') {
      try {
        dbSize = fs.statSync(config.databasePath).size;
      } catch {
        dbSize = null;
      }
    }
    return {
      config: publicConfig(config),
      database: {
        sizeBytes: dbSize,
        markets: repos.markets
          .list()
          .map((m) => ({ slug: m.slug, ...repos.rounds.stats(m.id, STATS_MAX_AGE_MS) })),
      },
      imports: repos.sync.imports(),
      sync: repos.sync.get(tradable().id),
      plugins: [...BUILTIN_STRATEGIES, manualOrder].map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
      })),
    };
  });

  server.post('/api/sync', async (req) => {
    const { action } = z.object({ action: z.enum(['incremental', 'reconcile']) }).parse(req.body);
    return action === 'incremental' ? app.history.syncIncremental() : app.history.reconcile();
  });

  // ------------------------------------------------------------------------------------------------ markets & rounds

  server.get('/api/markets', async () =>
    repos.markets.list().map((m) => ({
      ...m,
      stats: repos.rounds.stats(m.id, STATS_MAX_AGE_MS),
      timeRange: repos.rounds.timeRange(m.id),
    })),
  );

  server.get('/api/markets/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const m = repos.markets.get(id);
    if (!m) throw new HttpError(404, 'market not found');
    return {
      ...m,
      stats: repos.rounds.stats(m.id, STATS_MAX_AGE_MS),
      timeRange: repos.rounds.timeRange(m.id),
      sync: repos.sync.get(m.id),
    };
  });

  server.get('/api/rounds/current', async (_req, reply) => {
    const state = app.monitor.state;
    if (!state) return reply.code(503).send({ error: 'market state not available yet' });
    return { ...state, chainNow: app.monitor.chainNow(state) };
  });

  server.get('/api/rounds', async (req) => {
    const q = page
      .extend({
        marketId: int.positive().optional(),
        fromEpoch: int.optional(),
        toEpoch: int.optional(),
        from: int.optional(),
        to: int.optional(),
        outcome: z.enum(['BULL', 'BEAR', 'TIE', 'CANCELLED']).optional(),
        status: z.enum(['UPCOMING', 'OPEN', 'LOCKING', 'LIVE', 'CLOSING', 'ENDED', 'CANCELLED']).optional(),
        finalOnly: z.enum(['true', 'false']).optional(),
        order: z.enum(['asc', 'desc']).default('desc'),
      })
      .parse(req.query);
    return repos.rounds.list({
      marketId: q.marketId ?? tradable().id,
      fromEpoch: q.fromEpoch,
      toEpoch: q.toEpoch,
      fromTime: q.from,
      toTime: q.to,
      outcome: q.outcome,
      status: q.status,
      finalOnly: q.finalOnly === 'true',
      limit: q.limit,
      offset: q.offset,
      order: q.order,
    });
  });

  server.get('/api/rounds/:epoch', async (req) => {
    const { epoch } = z.object({ epoch: int.nonnegative() }).parse(req.params);
    const { marketId } = z.object({ marketId: int.positive().optional() }).parse(req.query);
    const market = marketId ? repos.markets.get(marketId) : tradable();
    if (!market) throw new HttpError(404, 'market not found');
    const round = repos.rounds.get(market.id, epoch);
    if (!round) throw new HttpError(404, `round ${epoch} not found`);
    const slugs = strategySlugs();
    return {
      market: { id: market.id, slug: market.slug, treasuryFeeBps: market.treasuryFeeBps },
      round,
      decisions: repos.decisions
        .forRound(round.id)
        .map((d) => ({ ...d, strategySlug: slugs.get(d.strategyId) ?? null })),
      trades: repos.trades.forRound(round.id).map((t) => ({
        ...t,
        strategySlug: t.strategyId === null ? null : (slugs.get(t.strategyId) ?? null),
      })),
      corrections: repos.rounds.corrections(round.id),
      audit: repos.audit.list({ epoch }, 100),
    };
  });

  // ------------------------------------------------------------------------------------------------ trades & decisions

  const tradeQuery = page.extend({
    mode: modeSchema.optional(),
    source: z.enum(['BOT', 'MANUAL', 'IMPORTED']).optional(),
    strategyId: int.positive().optional(),
    walletId: int.positive().optional(),
    marketId: int.positive().optional(),
    direction: z.enum(['BULL', 'BEAR']).optional(),
    status: z.enum(['PENDING', 'SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'SETTLED', 'FAILED']).optional(),
    result: z.enum(['WON', 'LOST', 'REFUNDED']).optional(),
    epoch: int.optional(),
    from: int.optional(),
    to: int.optional(),
    minAmount: bnbString.optional(),
    maxAmount: bnbString.optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
  });

  server.get('/api/trades', async (req) => {
    const q = tradeQuery.parse(req.query);
    const filter: TradeFilter = {
      mode: q.mode,
      source: q.source,
      strategyId: q.strategyId,
      walletId: q.walletId,
      marketId: q.marketId,
      direction: q.direction,
      status: q.status,
      result: q.result,
      epoch: q.epoch,
      fromTime: q.from,
      toTime: q.to,
      minAmountWei: q.minAmount,
      maxAmountWei: q.maxAmount,
    };
    const { rows, total } = repos.trades.list(filter, { limit: q.limit, offset: q.offset, order: q.order });
    const all = repos.trades.all(filter);
    const entries = app.portfolio.toEntries(all);
    const onlyAccountFilter = Object.entries(filter).every(
      ([k, v]) => v === undefined || k === 'mode' || k === 'walletId',
    );
    const account =
      q.mode === 'PAPER'
        ? app.portfolio.paperAccount()
        : q.mode === 'LIVE'
          ? app.portfolio.liveAccount(q.walletId)
          : null;
    const start = onlyAccountFilter ? (account?.startingBankroll ?? null) : null;
    const ann = annotateLedger(entries, start);
    const slugs = strategySlugs();
    const wallets = new Map(repos.wallets.list().map((w) => [w.id, w.address]));
    return {
      total,
      summary: computeSummary(entries, null),
      bankrollBasis: start === null ? null : account?.bankrollBasis,
      rows: rows.map((t: Trade) => ({
        ...t,
        strategySlug: t.strategyId === null ? null : (slugs.get(t.strategyId) ?? null),
        walletAddress: t.walletId === null ? null : (wallets.get(t.walletId) ?? null),
        running: ann.get(t.id) ?? null,
      })),
    };
  });

  server.get('/api/trades/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const t = repos.trades.get(id);
    if (!t) throw new HttpError(404, 'trade not found');
    return {
      trade: t,
      events: repos.trades.events(id),
      decision: t.decisionId ? repos.decisions.get(t.decisionId) : null,
      round: repos.rounds.getById(t.roundId),
      strategy: t.strategyId ? repos.strategies.get(t.strategyId) : null,
    };
  });

  server.post('/api/trades/manual', async (req) => {
    const body = z
      .object({ mode: modeSchema, direction: z.enum(['BULL', 'BEAR']), amountBnb: bnbString })
      .parse(req.body);
    const res = await app.engine.manualOrder({
      mode: body.mode,
      direction: body.direction,
      amountWei: body.amountBnb,
    });
    return { decision: res.decision, trade: res.trade };
  });

  server.get('/api/decisions', async (req) => {
    const q = page
      .extend({
        strategyId: int.positive().optional(),
        mode: modeSchema.optional(),
        decision: z.enum(['TRADE', 'NO_TRADE']).optional(),
        epoch: int.optional(),
      })
      .parse(req.query);
    const slugs = strategySlugs();
    const res = repos.decisions.list(q, { limit: q.limit, offset: q.offset });
    return {
      total: res.total,
      rows: res.rows.map((d) => ({ ...d, strategySlug: slugs.get(d.strategyId) ?? null })),
    };
  });

  // ------------------------------------------------------------------------------------------------ portfolio

  server.get('/api/portfolio', async (req) => {
    const q = z
      .object({
        mode: z.enum(['PAPER', 'LIVE', 'ALL']).default('PAPER'),
        walletId: int.positive().optional(),
        strategyId: int.positive().optional(),
        from: int.optional(),
        to: int.optional(),
      })
      .parse(req.query);
    return app.portfolio.report({
      mode: q.mode,
      walletId: q.walletId,
      strategyId: q.strategyId,
      fromMs: q.from,
      toMs: q.to,
    });
  });

  server.get('/api/portfolio/snapshots', async (req) => {
    const q = z.object({ mode: modeSchema.default('PAPER'), since: int.optional() }).parse(req.query);
    return repos.snapshots.list(q.mode, q.since ?? app.ctx.clock.nowMs() - 30 * 86_400_000);
  });

  // ------------------------------------------------------------------------------------------------ strategies

  const strategyView = (id: number) => {
    const s = repos.strategies.get(id);
    if (!s) throw new HttpError(404, 'strategy not found');
    const plugin = getPlugin(s.plugin);
    const perf = (mode: TradeMode) =>
      computeSummary(app.portfolio.toEntries(repos.trades.all({ mode, strategyId: s.id })));
    return {
      ...s,
      plugin: plugin
        ? {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            params: plugin.params,
            defaults: plugin.defaults,
          }
        : null,
      performance: { PAPER: perf('PAPER'), LIVE: perf('LIVE') },
      decisions: {
        total: repos.decisions.list({ strategyId: s.id }, { limit: 1, offset: 0 }).total,
        trades: repos.decisions.list({ strategyId: s.id, decision: 'TRADE' }, { limit: 1, offset: 0 }).total,
      },
    };
  };

  server.get('/api/strategies', async () => repos.strategies.list().map((s) => strategyView(s.id)));

  server.get('/api/strategies/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return {
      ...strategyView(id),
      recentDecisions: repos.decisions.list({ strategyId: id }, { limit: 25, offset: 0 }).rows,
    };
  });

  server.get('/api/strategies/:id/performance', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!repos.strategies.get(id)) throw new HttpError(404, 'strategy not found');
    return {
      PAPER: app.portfolio.report({ mode: 'PAPER', strategyId: id }).report,
      LIVE: app.portfolio.report({ mode: 'LIVE', strategyId: id }).report,
    };
  });

  server.patch('/api/strategies/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        paperTradingEnabled: z.boolean().optional(),
        liveTradingEnabled: z.boolean().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    const s = repos.strategies.get(id);
    if (!s) throw new HttpError(404, 'strategy not found');
    const plugin = getPlugin(s.plugin);
    if (!plugin) throw new HttpError(409, `plugin ${s.plugin} is not available`);
    if (body.config) {
      const parsed = parseStrategyConfig(plugin, body.config);
      if (!parsed.ok) throw new HttpError(400, `invalid config: ${parsed.errors.join('; ')}`);
      repos.strategies.updateConfig(id, parsed.value);
      app.audit.record({
        component: 'api',
        severity: 'INFO',
        type: AuditType.STRATEGY_CONFIG_CHANGED,
        strategyId: id,
        message: `${s.slug} configuration changed`,
        metadata: { before: s.config, after: parsed.value },
      });
    }
    if (
      body.enabled !== undefined ||
      body.paperTradingEnabled !== undefined ||
      body.liveTradingEnabled !== undefined
    ) {
      const updated = repos.strategies.setFlags(id, body);
      const changes = (['enabled', 'paperTradingEnabled', 'liveTradingEnabled'] as const).filter(
        (k) => body[k] !== undefined && body[k] !== s[k],
      );
      for (const k of changes) {
        app.audit.record({
          component: 'api',
          severity: k === 'liveTradingEnabled' && updated[k] ? 'WARN' : 'INFO',
          type: updated[k] ? AuditType.STRATEGY_ENABLED : AuditType.STRATEGY_DISABLED,
          strategyId: id,
          message: `${s.slug}: ${k} ${updated[k] ? 'on' : 'off'}`,
        });
      }
    }
    return strategyView(id);
  });

  // ------------------------------------------------------------------------------------------------ bot

  server.get('/api/bot/status', async () => {
    const state = app.monitor.state;
    const last = repos.decisions.list({}, { limit: 1, offset: 0 }).rows[0] ?? null;
    const lastTrade = repos.trades.list({}, { limit: 1, offset: 0, order: 'desc' }).rows[0] ?? null;
    return {
      ...app.bot.view(),
      inflightExecutions: app.execution.inflightCount,
      currentEpoch: state?.currentEpoch ?? null,
      secondsToLock: state?.next?.lockTime
        ? Math.round(state.next.lockTime - (app.monitor.chainNow(state) ?? 0))
        : null,
      marketStale: state?.stale ?? true,
      lastDecision: last,
      lastTrade,
      recentErrors: repos.audit.list({ severity: 'ERROR' }, 5),
      openLiveTrades: repos.trades.byStatus(['PENDING', 'SUBMITTING', 'SUBMITTED'], 'LIVE'),
    };
  });
  server.post('/api/bot/start', async (req) => app.bot.start(reasonBody.parse(req.body ?? {}).reason));
  server.post('/api/bot/stop', async (req) => app.bot.stop(reasonBody.parse(req.body ?? {}).reason));
  server.post('/api/bot/pause', async (req) => app.bot.pause(reasonBody.parse(req.body ?? {}).reason));
  server.post('/api/bot/resume', async (req) => app.bot.resume(reasonBody.parse(req.body ?? {}).reason));
  server.post('/api/bot/emergency-stop', async (req) =>
    app.bot.emergencyStop(reasonBody.parse(req.body ?? {}).reason ?? 'operator'),
  );
  server.post('/api/bot/reset', async (req) =>
    app.bot.resetEmergency(z.object({ acknowledge: z.boolean() }).parse(req.body).acknowledge),
  );
  server.post('/api/bot/live/arm', async (req) =>
    app.bot.armLive(z.object({ confirmation: z.string() }).parse(req.body).confirmation),
  );
  server.post('/api/bot/live/disarm', async (req) =>
    app.bot.disarmLive(reasonBody.parse(req.body ?? {}).reason),
  );

  // ------------------------------------------------------------------------------------------------ backtests

  server.post('/api/backtest', async (req, reply) => {
    const id = app.backtests.start(req.body);
    return reply.code(202).send({ id });
  });
  server.get('/api/backtest', async () => repos.backtests.list(50));
  server.get('/api/backtest/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const run = repos.backtests.get(id);
    if (!run) throw new HttpError(404, 'backtest not found');
    return run;
  });

  // ------------------------------------------------------------------------------------------------ wallets & claims

  server.get('/api/wallets', async () =>
    repos.wallets.list().map((w) => ({
      ...w,
      trades: repos.trades.list({ walletId: w.id }, { limit: 1, offset: 0, order: 'desc' }).total,
    })),
  );

  server.post('/api/wallets', async (req) => {
    const body = z
      .object({ address: z.string(), label: z.string().min(1).max(60).default('Watched wallet') })
      .parse(req.body);
    if (!isAddress(body.address)) throw new HttpError(400, 'invalid address');
    const address = getAddress(body.address);
    if (repos.wallets.byAddress(address)?.kind === 'SIGNER')
      throw new HttpError(409, 'this is the signing wallet');
    const w = repos.wallets.upsert(address, 'WATCH', body.label);
    app.audit.record({
      component: 'api',
      severity: 'INFO',
      type: AuditType.WALLET_ADDED,
      message: `watch wallet ${address} added`,
    });
    return w;
  });

  server.post('/api/wallets/:id/sync', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!repos.wallets.get(id)) throw new HttpError(404, 'wallet not found');
    return app.walletSync.syncWallet(id);
  });

  server.get('/api/wallet', async () => {
    const signer = repos.wallets.signer();
    let balance: bigint | null = null;
    let balanceError: string | null = null;
    if (signer) {
      try {
        balance = await app.ctx.reader.getBalance(signer.address as `0x${string}`);
        if (app.ctx.writer) app.portfolio.setLiveBalance(balance);
      } catch (err) {
        balanceError = errorMessage(err);
      }
    }
    const market = tradable();
    return {
      signer,
      hasSigner: app.ctx.writer !== null,
      balance,
      balanceError,
      account: signer ? app.portfolio.liveAccount(signer.id) : null,
      unclaimed: signer ? repos.trades.unclaimed(signer.id, market.id) : [],
      claims: repos.claims.list(20),
      liveTradingEnabled: config.liveTradingEnabled,
      liveArmed: app.bot.view().liveArmed,
      paperAccount: app.portfolio.paperAccount(),
    };
  });

  server.get('/api/claims', async () => repos.claims.list(100));
  server.post('/api/claims', async () => app.claims.run({ force: true }));

  // ------------------------------------------------------------------------------------------------ logs & stream

  server.get('/api/logs', async (req) => {
    const q = z
      .object({
        type: z.string().max(64).optional(),
        severity: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL']).optional(),
        component: z.string().max(64).optional(),
        epoch: int.optional(),
        strategyId: int.positive().optional(),
        tradeId: int.positive().optional(),
        beforeId: int.positive().optional(),
        limit: int.min(1).max(500).default(100),
      })
      .parse(req.query);
    return repos.audit.list(q, q.limit);
  });

  server.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) =>
      res.write(
        `event: ${event}\ndata: ${JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`,
      );
    send('hello', { bot: app.bot.view(), market: app.monitor.state });
    const off = app.bus.on((e) => send(e.type, e.data));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });
}
