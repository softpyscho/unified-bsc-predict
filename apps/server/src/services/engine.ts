/**
 * Strategy engine: Market data → Strategy → Signal → Risk → Execution. Each strategy runs isolated: an exception,
 * invalid config or missing data produces a recorded NO_TRADE decision and never a trade. Every final decision
 * (including "no bet") is persisted with its inputs and risk checks, so any round can answer "why?".
 */
import type { Decision, Direction, GateCheck, RiskState, StrategyConfig, TradeMode } from '@bsc/core';
import {
  OWN_TRADES_LOOKBACK,
  buildContext,
  decide,
  getPlugin,
  lookbackFor,
  manualOrder,
  mergeLimits,
  parseStrategyConfig,
  strategyLimitOverrides,
  weiToBnb,
  weiToBnbString,
} from '@bsc/core';
import type { NewDecision } from '../repositories/decisions.js';
import type { DecisionRecord, StrategyRow, Trade } from '../repositories/index.js';
import { errorMessage } from '../util/json.js';
import { AuditType } from './audit.js';
import type { BotController } from './bot.js';
import type { Ctx } from './context.js';
import type { ExecutionService } from './execution.js';
import type { MarketService } from './markets.js';
import type { RiskStateBuilder } from './riskState.js';
import type { MarketState, RoundMonitor } from './roundMonitor.js';

export class EngineError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface EvaluateArgs {
  strategy: StrategyRow;
  mode: TradeMode;
  state: MarketState;
  source: 'BOT' | 'MANUAL';
  manual?: { direction: Direction; amountWei: bigint };
}

export interface EvaluateResult {
  decision: DecisionRecord | null;
  trade: Trade | null;
  submission: Promise<Trade> | null;
  waiting?: boolean;
}

const failed = (reason: string, error: string): Decision => ({
  kind: 'NO_TRADE',
  signal: null,
  direction: null,
  intendedStakeWei: null,
  stakeWei: null,
  expectedEdge: null,
  edge: null,
  checks: [],
  reason,
  error,
});

export class StrategyEngine {
  private readonly inflight = new Set<string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly deps: {
      markets: MarketService;
      bot: BotController;
      execution: ExecutionService;
      risk: RiskStateBuilder;
      monitor: RoundMonitor;
    },
  ) {}

  /** Called after every market snapshot. Evaluates each enabled strategy once per round and mode. */
  async onMarketState(state: MarketState): Promise<void> {
    if (state.stale || state.paused || !(await this.deps.bot.canTrade())) return;
    const round = state.next;
    if (!round || round.status !== 'OPEN' || round.lockTime === null) return;
    const secondsToLock = round.lockTime - this.deps.monitor.chainNow(state)!;
    const jobs: Promise<unknown>[] = [];
    for (const strategy of await this.ctx.repos.strategies.list()) {
      if (!strategy.enabled || strategy.plugin === manualOrder.id || strategy.marketId !== state.marketId)
        continue;
      const entry = strategy.config?.timing?.entrySecondsBeforeLock ?? 30;
      if (secondsToLock > entry) continue;
      for (const mode of this.modesFor(strategy))
        jobs.push(this.evaluate({ strategy, mode, state, source: 'BOT' }));
    }
    await Promise.allSettled(jobs);
  }

  private modesFor(s: StrategyRow): TradeMode[] {
    const modes: TradeMode[] = [];
    if (s.paperTradingEnabled && this.ctx.config.paperTradingEnabled) modes.push('PAPER');
    // LIVE is evaluated whenever the strategy opts in, so a closed gate is recorded as the reason for not betting.
    if (s.liveTradingEnabled) modes.push('LIVE');
    return modes;
  }

  async manualOrder(input: {
    mode: TradeMode;
    direction: Direction;
    amountWei: bigint;
  }): Promise<EvaluateResult> {
    const state = this.deps.monitor.state;
    if (!state) throw new EngineError(503, 'market state not available yet');
    const strategy = await this.ctx.repos.strategies.bySlug(manualOrder.id);
    if (!strategy) throw new EngineError(500, 'manual strategy is not seeded');
    return this.evaluate(
      {
        strategy,
        mode: input.mode,
        state,
        source: 'MANUAL',
        manual: { direction: input.direction, amountWei: input.amountWei },
      },
      true,
    );
  }

  async evaluate(args: EvaluateArgs, strict = false): Promise<EvaluateResult> {
    const { strategy, mode, state, source } = args;
    const none: EvaluateResult = { decision: null, trade: null, submission: null };
    const round = state.next;
    if (!round || round.status !== 'OPEN' || round.lockTime === null || round.startTime === null) {
      if (strict) throw new EngineError(409, 'no round is open for bets');
      return none;
    }
    const key = `${strategy.id}:${round.id}:${mode}`;
    const duplicate = () => {
      if (strict)
        throw new EngineError(
          409,
          `a ${mode} decision for round ${round.epoch} already exists (${strategy.slug})`,
        );
      return none;
    };
    // Reserve the key before the first await so a concurrent evaluation of the same round cannot slip through.
    if (this.inflight.has(key)) return duplicate();
    this.inflight.add(key);
    let exists: boolean;
    try {
      exists = await this.ctx.repos.decisions.exists(strategy.id, round.id, mode);
    } catch (err) {
      this.inflight.delete(key);
      throw err;
    }
    if (exists) {
      this.inflight.delete(key);
      return duplicate();
    }
    const decidedAt = this.ctx.clock.nowMs();
    try {
      const now = this.deps.monitor.chainNow(state)!;
      const { decision, inputs } = await this.decideFor(args, now);
      if (decision.kind === 'WAIT') return { ...none, waiting: true };

      const record: NewDecision = {
        strategyId: strategy.id,
        marketId: state.marketId,
        roundId: round.id,
        epoch: round.epoch,
        mode,
        signal: decision.signal?.action ?? null,
        confidence: decision.signal?.confidence ?? null,
        decision: decision.kind === 'TRADE' ? 'TRADE' : 'NO_TRADE',
        direction: decision.direction,
        intendedAmount: decision.intendedStakeWei,
        actualAmount: decision.kind === 'TRADE' ? decision.stakeWei : null,
        expectedEdge: decision.expectedEdge,
        reason: decision.reason,
        rationale: decision.signal?.rationale ?? null,
        riskChecks: decision.checks,
        inputs,
        indicators: decision.signal?.indicators ?? null,
        error: decision.error,
        tradeId: null,
        decidedAt,
        secondsToLock: (round.lockTime ?? 0) - now,
      };
      const placed = await this.deps.execution.place({
        strategy,
        market: this.deps.markets.tradable(),
        round,
        mode,
        source,
        decision,
        record,
      });
      placed.submission?.catch((err: unknown) =>
        this.ctx.log.tx.error({ err, strategy: strategy.slug }, 'live submission crashed'),
      );
      await this.auditDecision(placed.decision, strategy, decision);
      this.ctx.bus.emit('decision', placed.decision);
      return placed;
    } catch (err) {
      this.ctx.log.strategy.error(
        { err, strategy: strategy.slug, epoch: round.epoch, mode },
        'strategy evaluation failed',
      );
      await this.ctx.audit.record({
        component: 'strategy-engine',
        severity: 'ERROR',
        type: AuditType.STRATEGY_ERROR,
        epoch: round.epoch,
        strategyId: strategy.id,
        message: `${strategy.slug} ${mode} evaluation failed: ${errorMessage(err)}`,
      });
      if (strict) throw err;
      return none;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async decideFor(
    args: EvaluateArgs,
    now: number,
  ): Promise<{ decision: Decision; inputs: Record<string, unknown> }> {
    const { strategy, mode, state } = args;
    const round = state.next!;
    const plugin = getPlugin(strategy.plugin);
    if (!plugin)
      return { decision: failed(`PLUGIN_NOT_FOUND: ${strategy.plugin}`, 'unknown plugin'), inputs: {} };
    const parsed = parseStrategyConfig(plugin, strategy.config);
    if (!parsed.ok)
      return {
        decision: failed(`CONFIG_INVALID: ${parsed.errors.join('; ')}`, 'invalid config'),
        inputs: {},
      };
    let config: StrategyConfig = parsed.value;
    if (args.manual) {
      config = {
        ...config,
        params: { ...config.params, direction: args.manual.direction },
        sizing: { ...config.sizing, mode: 'FIXED', fixedBnb: Number(weiToBnbString(args.manual.amountWei)) },
      };
    }
    const limits = mergeLimits(this.ctx.config.risk, strategyLimitOverrides(config));

    let riskState: RiskState;
    try {
      riskState = await this.deps.risk.build({
        mode,
        strategyId: strategy.id,
        marketId: state.marketId,
        round,
        now,
      });
    } catch (err) {
      return {
        decision: failed(`RISK_STATE_UNAVAILABLE: ${errorMessage(err)}`, errorMessage(err)),
        inputs: {},
      };
    }

    const lookback = lookbackFor(plugin, config);
    const history = await this.ctx.repos.rounds.recentFinal(state.marketId, round.epoch, lookback);
    const ownTrades = (
      await this.ctx.repos.trades.recentForStrategy(strategy.id, mode, round.epoch, OWN_TRADES_LOOKBACK)
    ).map((t) => ({
      epoch: t.epoch,
      direction: t.direction,
      amountBnb: weiToBnb(t.amount),
      status: t.status,
      result: t.result,
    }));
    const sctx = buildContext({
      mode,
      now,
      betting: {
        epoch: round.epoch,
        startTime: round.startTime!,
        lockTime: round.lockTime!,
        pool: { bullAmount: round.bullAmount, bearAmount: round.bearAmount },
      },
      live: state.live,
      history,
      lookback,
      ownTrades,
      price: state.oracle ? { value: state.oracle.price, updatedAt: state.oracle.updatedAt } : null,
      bankrollWei: riskState.bankrollWei,
      treasuryFeeBps: state.params.treasuryFeeBps,
      bufferSeconds: state.params.bufferSeconds,
    });
    const decision = decide({
      mode,
      plugin,
      config,
      ctx: sctx,
      limits,
      state: riskState,
      gates: await this.gates(mode, strategy, state, args.source),
      minBetWei: state.params.minBetWei,
      treasuryFeeBps: state.params.treasuryFeeBps,
      edgeModel: {
        gasBetBnb: weiToBnb(this.ctx.config.simulatedGasPerBetWei),
        gasClaimBnb: weiToBnb(this.ctx.config.simulatedGasPerClaimWei),
        balancePull: this.ctx.config.edge.balancePull,
      },
    });
    const inputs = {
      chainTime: Math.round(now),
      secondsToLock: Number(sctx.betting.secondsToLock.toFixed(1)),
      pool: sctx.betting.pool,
      oraclePrice: sctx.price?.value ?? null,
      liveRound: sctx.live,
      historyRounds: sctx.history.length,
      lastHistoryEpoch: sctx.history.at(-1)?.epoch ?? null,
      bankroll: riskState.bankrollWei.toString(),
      available: riskState.availableWei.toString(),
      exposure: riskState.exposureWei.toString(),
      dailyNetPnl: riskState.dailyNetPnlWei.toString(),
      lossStreak: riskState.lossStreak,
      gasPrice: riskState.gasPriceWei?.toString() ?? null,
      params: config.params,
      sizing: config.sizing,
      edge: decision.edge,
    };
    return { decision, inputs };
  }

  /** Preconditions evaluated as risk checks. For LIVE this is the explicit multi-condition live-trading gate. */
  private async gates(
    mode: TradeMode,
    s: StrategyRow,
    state: MarketState,
    source: 'BOT' | 'MANUAL',
  ): Promise<GateCheck[]> {
    const bot = await this.deps.bot.view();
    const g = (rule: string, passed: boolean, detail: string): GateCheck => ({ rule, passed, detail });
    const running = bot.status === 'RUNNING' && bot.phase === 'READY';
    const common = [
      mode === 'PAPER' && source === 'MANUAL'
        ? g(
            'BOT_RUNNING',
            bot.status !== 'EMERGENCY_STOPPED',
            `bot ${bot.status} (manual paper orders allowed unless emergency-stopped)`,
          )
        : g('BOT_RUNNING', running, `bot ${bot.status}, phase ${bot.phase}`),
      g('STRATEGY_ENABLED', s.enabled, s.enabled ? 'enabled' : 'strategy disabled'),
      g(
        'MARKET_ACTIVE',
        !state.paused && !state.stale,
        state.paused ? 'contract paused' : state.stale ? 'market data stale' : 'ok',
      ),
    ];
    if (mode === 'PAPER') {
      return [
        ...common,
        g(
          'PAPER_TRADING_ENABLED',
          this.ctx.config.paperTradingEnabled,
          'PAPER_TRADING_ENABLED environment flag',
        ),
        g('STRATEGY_PAPER_ENABLED', s.paperTradingEnabled, 'strategy paper flag'),
      ];
    }
    const signer = await this.ctx.repos.wallets.signer();
    const walletValid =
      this.ctx.writer !== null &&
      signer !== undefined &&
      signer.address.toLowerCase() === this.ctx.writer.address.toLowerCase();
    return [
      ...common,
      g('LIVE_TRADING_ENABLED', this.ctx.config.liveTradingEnabled, 'LIVE_TRADING_ENABLED environment flag'),
      g(
        'LIVE_ARMED',
        bot.liveArmed,
        bot.liveArmed ? `armed at ${bot.liveArmedAt}` : 'live trading not armed from the dashboard',
      ),
      g(
        'WALLET_VALID',
        walletValid,
        walletValid ? `signer ${this.ctx.writer!.address}` : 'no valid signing wallet',
      ),
      g('STRATEGY_LIVE_ENABLED', s.liveTradingEnabled, 'strategy live flag'),
      g(
        'CIRCUIT_BREAKER',
        bot.consecutiveFailures < this.ctx.config.maxExecutionFailures,
        `${bot.consecutiveFailures} consecutive execution failures (limit ${this.ctx.config.maxExecutionFailures})`,
      ),
    ];
  }

  private async auditDecision(d: DecisionRecord, s: StrategyRow, decision: Decision): Promise<void> {
    const base = {
      component: 'strategy-engine',
      marketId: d.marketId,
      epoch: d.epoch,
      strategyId: s.id,
      tradeId: d.tradeId,
    };
    await this.ctx.audit.record({
      ...base,
      severity: decision.error ? 'WARN' : 'INFO',
      type: decision.error ? AuditType.STRATEGY_ERROR : AuditType.SIGNAL_GENERATED,
      message: `${s.slug} ${d.mode} round ${d.epoch}: ${d.signal ?? 'NO SIGNAL'}${d.confidence !== null ? ` (confidence ${d.confidence})` : ''} — ${d.reason}`,
      metadata: { decisionId: d.id, indicators: d.indicators },
    });
    if (d.signal === 'BUY_UP' || d.signal === 'BUY_DOWN') {
      await this.ctx.audit.record({
        ...base,
        severity: 'INFO',
        type: d.decision === 'TRADE' ? AuditType.TRADE_APPROVED : AuditType.TRADE_REJECTED,
        message:
          d.decision === 'TRADE'
            ? `${d.mode} ${d.direction} ${weiToBnbString(d.actualAmount ?? 0n)} BNB approved`
            : `${d.mode} ${d.direction} rejected — ${d.reason}`,
        metadata: { decisionId: d.id, failedChecks: d.riskChecks.filter((c) => !c.passed) },
      });
    }
  }
}
