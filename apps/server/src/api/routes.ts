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
  const strategySlugs = async () => new Map((await repos.strategies.list()).map((s) => [s.id, s.slug]));
  const withStats = async (m: { id: number }) => ({
    stats: await repos.rounds.stats(m.id, STATS_MAX_AGE_MS),
    timeRange: await repos.rounds.timeRange(m.id),
  });

  const modeOverview = async (mode: TradeMode) => {
    const signer = await repos.wallets.signer();
    if (mode === 'LIVE' && !signer)
      return {
        account: await app.portfolio.liveAccount(),
        summary: computeSummary([]),
        todayPnl: 0n,
        todayTrades: 0,
      };
    const trades = await repos.trades.all({ mode, walletId: mode === 'LIVE' ? signer!.id : undefined });
    const account =
      mode === 'PAPER' ? await app.portfolio.paperAccount() : await app.portfolio.liveAccount(signer!.id);
    const entries = await app.portfolio.toEntries(trades);
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
    // Freshness only: collector errors can contain RPC URLs, which may embed API keys.
    const poolSync = config.poolEvents.enabled
      ? await repos.poolEvents.sync(tradable().id).catch(() => null)
      : null;
    const poolAge = poolSync ? Math.round((Date.now() - Date.parse(poolSync.updatedAt)) / 1000) : null;
    let db = 'ok';
    let bot: { status: string; phase: string } = { status: 'UNKNOWN', phase: app.bot.phase };
    try {
      await repos.db.get('SELECT 1');
      const view = await app.bot.view();
      bot = { status: view.status, phase: view.phase };
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
      bot,
      workerLoops: app.worker.loopsRunning,
      poolEvents: {
        enabled: config.poolEvents.enabled,
        ok:
          !config.poolEvents.enabled ||
          (poolSync !== null && poolSync.forwardFailures === 0 && poolAge !== null && poolAge < 120),
        lastRunAgeSeconds: poolAge,
        collectedToBlock: poolSync?.toBlock ?? null,
        backfillDone: poolSync?.backfillDone ?? null,
      },
    };
  });

  server.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    if (sessions.isRateLimited(ip))
      return reply.code(429).send({ error: 'too many attempts; try again later' });
    const body = z.object({ token: z.string().min(1).max(512) }).parse(req.body);
    if (!sessions.verifyToken(body.token)) {
      sessions.recordFailure(ip);
      await app.audit.record({
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
    const slugs = await strategySlugs();
    const latestTrades = (await repos.trades.list({}, { limit: 10, offset: 0, order: 'desc' })).rows.map(
      (t) => ({
        ...t,
        strategySlug: t.strategyId === null ? null : (slugs.get(t.strategyId) ?? null),
      }),
    );
    const latestDecisions = (await repos.decisions.list({}, { limit: 10, offset: 0 })).rows.map((d) => ({
      ...d,
      strategySlug: slugs.get(d.strategyId) ?? null,
    }));
    const alerts = [
      ...(await repos.audit.list({ severity: 'CRITICAL' }, 5)),
      ...(await repos.audit.list({ severity: 'ERROR' }, 10)),
      ...(await repos.audit.list({ severity: 'WARN' }, 10)),
    ]
      .sort((a, b) => b.id - a.id)
      .slice(0, 10);
    return {
      market: app.monitor.state,
      bot: await app.bot.view(),
      paper: await modeOverview('PAPER'),
      live: await modeOverview('LIVE'),
      latestTrades,
      latestDecisions,
      alerts,
      activeStrategies: (await repos.strategies.list())
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
    const dbSize = await repos.db.sizeBytes().catch(() => null);
    return {
      config: publicConfig(config),
      database: {
        engine: repos.db.engine,
        sizeBytes: dbSize,
        markets: await Promise.all(
          (await repos.markets.list()).map(async (m) => ({
            slug: m.slug,
            ...(await repos.rounds.stats(m.id, STATS_MAX_AGE_MS)),
          })),
        ),
      },
      imports: await repos.sync.imports(),
      sync: await repos.sync.get(tradable().id),
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
    Promise.all((await repos.markets.list()).map(async (m) => ({ ...m, ...(await withStats(m)) }))),
  );

  server.get('/api/markets/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const m = await repos.markets.get(id);
    if (!m) throw new HttpError(404, 'market not found');
    return { ...m, ...(await withStats(m)), sync: await repos.sync.get(m.id) };
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
    const market = marketId ? await repos.markets.get(marketId) : tradable();
    if (!market) throw new HttpError(404, 'market not found');
    const round = await repos.rounds.get(market.id, epoch);
    if (!round) throw new HttpError(404, `round ${epoch} not found`);
    const slugs = await strategySlugs();
    return {
      market: { id: market.id, slug: market.slug, treasuryFeeBps: market.treasuryFeeBps },
      round,
      decisions: (await repos.decisions.forRound(round.id)).map((d) => ({
        ...d,
        strategySlug: slugs.get(d.strategyId) ?? null,
      })),
      trades: (await repos.trades.forRound(round.id)).map((t) => ({
        ...t,
        strategySlug: t.strategyId === null ? null : (slugs.get(t.strategyId) ?? null),
      })),
      poolEvents: await repos.poolEvents.forRound(market.id, epoch),
      corrections: await repos.rounds.corrections(round.id),
      audit: await repos.audit.list({ epoch }, 100),
    };
  });

  server.get('/api/pool-events', async () => app.poolEvents.status());

  // ------------------------------------------------------------------------------------------------ research

  server.get('/api/research/experiments', async () => app.research.list());
  server.get('/api/research/experiments/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const view = await app.research.view(id);
    if (!view) throw new HttpError(404, 'experiment not found');
    return view;
  });
  server.post('/api/research/experiments', async (req, reply) => {
    const exp = await app.research.register(req.body);
    app.research.runInBackground(exp.id);
    return reply.code(202).send({ id: exp.id });
  });
  server.get('/api/research/ledger', async () => app.research.ledger());

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
    const { rows, total } = await repos.trades.list(filter, {
      limit: q.limit,
      offset: q.offset,
      order: q.order,
    });
    const entries = await app.portfolio.toEntries(await repos.trades.all(filter));
    const onlyAccountFilter = Object.entries(filter).every(
      ([k, v]) => v === undefined || k === 'mode' || k === 'walletId',
    );
    const account =
      q.mode === 'PAPER'
        ? await app.portfolio.paperAccount()
        : q.mode === 'LIVE'
          ? await app.portfolio.liveAccount(q.walletId)
          : null;
    const start = onlyAccountFilter ? (account?.startingBankroll ?? null) : null;
    const ann = annotateLedger(entries, start);
    const slugs = await strategySlugs();
    const wallets = new Map((await repos.wallets.list()).map((w) => [w.id, w.address]));
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
    const t = await repos.trades.get(id);
    if (!t) throw new HttpError(404, 'trade not found');
    return {
      trade: t,
      events: await repos.trades.events(id),
      decision: t.decisionId ? await repos.decisions.get(t.decisionId) : null,
      round: await repos.rounds.getById(t.roundId),
      strategy: t.strategyId ? await repos.strategies.get(t.strategyId) : null,
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
    const slugs = await strategySlugs();
    const res = await repos.decisions.list(q, { limit: q.limit, offset: q.offset });
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

  const strategyView = async (id: number) => {
    const s = await repos.strategies.get(id);
    if (!s) throw new HttpError(404, 'strategy not found');
    const plugin = getPlugin(s.plugin);
    const perf = async (mode: TradeMode) =>
      computeSummary(await app.portfolio.toEntries(await repos.trades.all({ mode, strategyId: s.id })));
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
      performance: { PAPER: await perf('PAPER'), LIVE: await perf('LIVE') },
      decisions: {
        total: (await repos.decisions.list({ strategyId: s.id }, { limit: 1, offset: 0 })).total,
        trades: (await repos.decisions.list({ strategyId: s.id, decision: 'TRADE' }, { limit: 1, offset: 0 }))
          .total,
      },
    };
  };

  server.get('/api/strategies', async () =>
    Promise.all((await repos.strategies.list()).map((s) => strategyView(s.id))),
  );

  server.get('/api/strategies/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return {
      ...(await strategyView(id)),
      recentDecisions: (await repos.decisions.list({ strategyId: id }, { limit: 25, offset: 0 })).rows,
    };
  });

  server.get('/api/strategies/:id/performance', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!(await repos.strategies.get(id))) throw new HttpError(404, 'strategy not found');
    return {
      PAPER: (await app.portfolio.report({ mode: 'PAPER', strategyId: id })).report,
      LIVE: (await app.portfolio.report({ mode: 'LIVE', strategyId: id })).report,
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
    const s = await repos.strategies.get(id);
    if (!s) throw new HttpError(404, 'strategy not found');
    const plugin = getPlugin(s.plugin);
    if (!plugin) throw new HttpError(409, `plugin ${s.plugin} is not available`);
    if (body.config) {
      const parsed = parseStrategyConfig(plugin, body.config);
      if (!parsed.ok) throw new HttpError(400, `invalid config: ${parsed.errors.join('; ')}`);
      await repos.strategies.updateConfig(id, parsed.value);
      await app.audit.record({
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
      const updated = await repos.strategies.setFlags(id, body);
      const changes = (['enabled', 'paperTradingEnabled', 'liveTradingEnabled'] as const).filter(
        (k) => body[k] !== undefined && body[k] !== s[k],
      );
      for (const k of changes) {
        await app.audit.record({
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
    const last = (await repos.decisions.list({}, { limit: 1, offset: 0 })).rows[0] ?? null;
    const lastTrade = (await repos.trades.list({}, { limit: 1, offset: 0, order: 'desc' })).rows[0] ?? null;
    return {
      ...(await app.bot.view()),
      inflightExecutions: app.execution.inflightCount,
      currentEpoch: state?.currentEpoch ?? null,
      secondsToLock: state?.next?.lockTime
        ? Math.round(state.next.lockTime - (app.monitor.chainNow(state) ?? 0))
        : null,
      marketStale: state?.stale ?? true,
      lastDecision: last,
      lastTrade,
      recentErrors: await repos.audit.list({ severity: 'ERROR' }, 5),
      openLiveTrades: await repos.trades.byStatus(['PENDING', 'SUBMITTING', 'SUBMITTED'], 'LIVE'),
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
    const id = await app.backtests.start(req.body);
    return reply.code(202).send({ id });
  });
  server.get('/api/backtest', async () => repos.backtests.list(50));
  server.get('/api/backtest/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const run = await repos.backtests.get(id);
    if (!run) throw new HttpError(404, 'backtest not found');
    return run;
  });

  // ------------------------------------------------------------------------------------------------ wallets & claims

  server.get('/api/wallets', async () =>
    Promise.all(
      (await repos.wallets.list()).map(async (w) => ({
        ...w,
        trades: (await repos.trades.list({ walletId: w.id }, { limit: 1, offset: 0, order: 'desc' })).total,
      })),
    ),
  );

  server.post('/api/wallets', async (req) => {
    const body = z
      .object({ address: z.string(), label: z.string().min(1).max(60).default('Watched wallet') })
      .parse(req.body);
    if (!isAddress(body.address)) throw new HttpError(400, 'invalid address');
    const address = getAddress(body.address);
    if ((await repos.wallets.byAddress(address))?.kind === 'SIGNER')
      throw new HttpError(409, 'this is the signing wallet');
    const w = await repos.wallets.upsert(address, 'WATCH', body.label);
    await app.audit.record({
      component: 'api',
      severity: 'INFO',
      type: AuditType.WALLET_ADDED,
      message: `watch wallet ${address} added`,
    });
    return w;
  });

  server.post('/api/wallets/:id/sync', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!(await repos.wallets.get(id))) throw new HttpError(404, 'wallet not found');
    return app.walletSync.syncWallet(id);
  });

  server.get('/api/wallet', async () => {
    const signer = await repos.wallets.signer();
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
      account: signer ? await app.portfolio.liveAccount(signer.id) : null,
      unclaimed: signer ? await repos.trades.unclaimed(signer.id, market.id) : [],
      claims: await repos.claims.list(20),
      liveTradingEnabled: config.liveTradingEnabled,
      liveArmed: (await app.bot.view()).liveArmed,
      paperAccount: await app.portfolio.paperAccount(),
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

  server.get('/api/stream', async (req, reply) => {
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
    send('hello', { bot: await app.bot.view(), market: app.monitor.state });
    const off = app.bus.on((e) => send(e.type, e.data));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });
}
