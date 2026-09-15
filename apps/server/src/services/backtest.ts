/** Backtests over the canonical rounds table using the core replay engine (same decide() as live). */
import type { BacktestStrategyResult, StrategyConfig, StrategyPlugin, WalkForwardResult } from '@bsc/core';
import {
  BacktestRunner,
  WalkForwardRunner,
  bnbToWei,
  defaultStrategyConfig,
  downsample,
  getPlugin,
  manualOrder,
  parseStrategyConfig,
} from '@bsc/core';
import { z } from 'zod';
import { errorMessage } from '../util/json.js';
import type { Ctx } from './context.js';
import type { MarketService } from './markets.js';

export const BacktestRequestSchema = z.object({
  marketId: z.number().int().positive().optional(),
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  startingBankrollBnb: z.number().positive().max(1_000_000).default(1),
  gasPerBetBnb: z.number().min(0).max(1).optional(),
  gasPerClaimBnb: z.number().min(0).max(1).optional(),
  applyGlobalLimits: z.boolean().default(true),
  strategies: z
    .array(
      z.object({
        strategyId: z.number().int().positive().optional(),
        plugin: z.string().optional(),
        label: z.string().max(60).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(6),
  /** Tune one strategy over `grid` on rolling training windows and score each choice on the next, unseen window. */
  walkForward: z
    .object({
      trainRounds: z.number().int().min(10),
      testRounds: z.number().int().min(1),
      stepRounds: z.number().int().min(1).optional(),
      anchored: z.boolean().default(false),
      objective: z.enum(['netPnl', 'roi']).default('netPnl'),
      grid: z.record(z.string(), z.array(z.union([z.number(), z.string(), z.boolean()])).max(16)).default({}),
    })
    .optional(),
});
export type BacktestRequest = z.infer<typeof BacktestRequestSchema>;

export class BacktestInputError extends Error {
  readonly statusCode = 400;
}

const MAX_ROUNDS = 600_000;
/** Rounds per synchronous chunk; small enough to keep the market loop responsive in the server process. */
const STEP = 2_000;
const EQUITY_POINTS = 1_500;
const SAMPLE_TRADES = 200;

function mergeConfig(base: StrategyConfig, override: Record<string, unknown> | undefined): unknown {
  if (!override) return base;
  const o = override as Partial<Record<keyof StrategyConfig, Record<string, unknown>>>;
  return {
    ...base,
    ...override,
    params: { ...base.params, ...(o.params ?? {}) },
    timing: { ...base.timing, ...(o.timing ?? {}) },
    sizing: { ...base.sizing, ...(o.sizing ?? {}) },
    limits: { ...base.limits, ...(o.limits ?? {}) },
  };
}

export class BacktestService {
  private active: number | null = null;
  private starting = false;
  private runPromise: Promise<void> | null = null;
  private aborted = false;

  /** Stops an in-flight run before the database closes (it is recorded as FAILED). */
  async shutdown(): Promise<void> {
    this.aborted = true;
    await this.runPromise;
  }

  constructor(
    private readonly ctx: Ctx,
    private readonly markets: MarketService,
  ) {}

  get running(): number | null {
    return this.active;
  }

  /** Validates, loads data and starts the run in the background. Returns the run id. */
  async start(input: unknown): Promise<number> {
    const req = BacktestRequestSchema.parse(input);
    if (this.active !== null) throw new BacktestInputError(`backtest #${this.active} is still running`);
    if (this.starting) throw new BacktestInputError('another backtest is being started');
    if (req.to <= req.from) throw new BacktestInputError('"to" must be after "from"');
    if (req.walkForward && req.strategies.length !== 1)
      throw new BacktestInputError('walk-forward tunes exactly one strategy (its grid is the search space)');
    this.starting = true;
    try {
      return await this.launch(req);
    } finally {
      this.starting = false;
    }
  }

  private async launch(req: BacktestRequest): Promise<number> {
    const { repos, config } = this.ctx;
    const market = req.marketId ? await repos.markets.get(req.marketId) : this.markets.tradable();
    if (!market) throw new BacktestInputError('unknown market');
    if (market.timing !== 'TIMESTAMP')
      throw new BacktestInputError(`${market.slug} has no round timestamps and cannot be replayed`);

    const specs: { key: string; plugin: StrategyPlugin; config: StrategyConfig }[] = [];
    for (const [i, s] of req.strategies.entries()) {
      let plugin: StrategyPlugin | undefined;
      let base: StrategyConfig;
      let key: string;
      if (s.strategyId !== undefined) {
        const row = await repos.strategies.get(s.strategyId);
        if (!row) throw new BacktestInputError(`strategy ${s.strategyId} not found`);
        plugin = getPlugin(row.plugin);
        if (!plugin) throw new BacktestInputError(`plugin ${row.plugin} not found`);
        base = row.config;
        key = s.label ?? row.slug;
      } else if (s.plugin) {
        plugin = getPlugin(s.plugin);
        if (!plugin) throw new BacktestInputError(`plugin ${s.plugin} not found`);
        base = defaultStrategyConfig(plugin, Number(config.defaultBetWei) / 1e18);
        key = s.label ?? s.plugin;
      } else {
        throw new BacktestInputError(`strategies[${i}]: strategyId or plugin is required`);
      }
      if (plugin.id === manualOrder.id)
        throw new BacktestInputError('the manual strategy cannot be backtested');
      const parsed = parseStrategyConfig(plugin, mergeConfig(base, s.config));
      if (!parsed.ok) throw new BacktestInputError(`${key}: ${parsed.errors.join('; ')}`);
      specs.push({
        key:
          req.strategies.filter((x, j) => j < i && (x.label ?? x.plugin) === key).length > 0
            ? `${key}#${i + 1}`
            : key,
        plugin,
        config: parsed.value,
      });
    }

    const rounds = await repos.rounds.finalForBacktest(market.id, req.from, req.to);
    if (rounds.length < 10)
      throw new BacktestInputError(`only ${rounds.length} final rounds in the selected range`);
    if (rounds.length > MAX_ROUNDS)
      throw new BacktestInputError(`range contains ${rounds.length} rounds (max ${MAX_ROUNDS})`);

    const gasPerBetWei =
      req.gasPerBetBnb !== undefined ? bnbToWei(req.gasPerBetBnb) : config.simulatedGasPerBetWei;
    const gasPerClaimWei =
      req.gasPerClaimBnb !== undefined ? bnbToWei(req.gasPerClaimBnb) : config.simulatedGasPerClaimWei;
    const globalLimits = req.applyGlobalLimits
      ? { ...config.risk, maxGasPriceWei: null }
      : {
          ...config.risk,
          maxStakeWei: bnbToWei(req.startingBankrollBnb),
          minStakeWei: 0n,
          escalationStakeWei: 0n,
          maxBankrollFraction: 1,
          maxDailyLossWei: 0n,
          maxConsecutiveLosses: 0,
          maxExposureWei: bnbToWei(req.startingBankrollBnb) * 10n,
          minWalletBalanceWei: 0n,
          maxGasPriceWei: null,
        };
    const common = {
      market: market.slug,
      rounds,
      startingBankrollWei: bnbToWei(req.startingBankrollBnb),
      gasPerBetWei,
      gasPerClaimWei,
      treasuryFeeBps: market.treasuryFeeBps,
      minBetWei: market.minBetWei ?? bnbToWei('0.001'),
      bufferSeconds: market.bufferSeconds ?? 30,
      globalLimits,
    };
    let job: {
      step(): void;
      done(): boolean;
      progress(): number;
      result(): Record<string, unknown>;
    };
    if (req.walkForward) {
      const w = req.walkForward;
      const spec = specs[0]!;
      let wf: WalkForwardRunner;
      try {
        wf = new WalkForwardRunner({
          ...common,
          plugin: spec.plugin,
          base: spec.config,
          grid: w.grid,
          trainRounds: w.trainRounds,
          testRounds: w.testRounds,
          stepRounds: w.stepRounds,
          anchored: w.anchored,
          objective: w.objective,
        });
      } catch (err) {
        throw new BacktestInputError(errorMessage(err));
      }
      // Training windows replay every candidate side by side: keep each chunk's work about constant.
      const budget = Math.max(50, Math.floor(STEP / wf.candidateCount));
      job = {
        step: () => wf.step(budget),
        done: () => wf.done,
        progress: () => wf.progress,
        result: () => this.walkForwardResult(spec, wf.result()),
      };
    } else {
      const runner = new BacktestRunner({ ...common, strategies: specs });
      job = {
        step: () => runner.step(STEP),
        done: () => runner.done,
        progress: () => runner.processed / runner.total,
        result: () => ({ results: runner.results().map((r) => this.summarize(r)) }),
      };
    }

    const runId = await repos.backtests.create(req);
    this.active = runId;
    const started = Date.now();
    const meta = {
      market: market.slug,
      from: req.from,
      to: req.to,
      rounds: rounds.length,
      firstEpoch: rounds[0]!.epoch,
      lastEpoch: rounds.at(-1)!.epoch,
      startingBankroll: bnbToWei(req.startingBankrollBnb),
      gasPerBet: gasPerBetWei,
      gasPerClaim: gasPerClaimWei,
      treasuryFeeBps: market.treasuryFeeBps,
      appliedGlobalLimits: req.applyGlobalLimits,
      walkForward: req.walkForward ?? null,
      assumptions: [
        req.walkForward
          ? 'Walk-forward: each fold picks a grid candidate on its training window only and trades it unchanged on the next window; folds start from the same bankroll with no own-trade history.'
          : null,
        'Each strategy decides at lockTime − entrySecondsBeforeLock using only rounds final at that time.',
        'The betting round pool and oracle price are not visible (they are unknown before lock in the dataset).',
        'Payouts use the contract formula with the simulated stake added to the recorded pool (own dilution modelled).',
        'Gas per bet and per claim are fixed assumptions; ties lose, cancelled rounds refund the stake.',
        market.protocol === 'PRDT' ? 'PRDT referral bonuses are not modelled.' : null,
      ].filter(Boolean),
    };

    this.runPromise = (async () => {
      try {
        while (!job.done()) {
          if (this.aborted) throw new Error('aborted: process shutting down');
          job.step();
          const progress = job.progress();
          await repos.backtests.progress(runId, progress);
          this.ctx.bus.emit('backtest', { id: runId, status: 'RUNNING', progress });
          await new Promise((r) => setImmediate(r));
        }
        await repos.backtests.finish(runId, { ...meta, ...job.result() }, Date.now() - started);
        this.ctx.bus.emit('backtest', { id: runId, status: 'DONE', progress: 1 });
      } catch (err) {
        await repos.backtests.fail(runId, errorMessage(err)).catch(() => undefined);
        this.ctx.log.app.error({ err, runId }, 'backtest failed');
        this.ctx.bus.emit('backtest', { id: runId, status: 'FAILED', error: errorMessage(err) });
      } finally {
        this.active = null;
      }
    })();
    return runId;
  }

  /**
   * The out-of-sample record is reported in the same shape as a plain backtest result (so every view of a backtest
   * works), plus the per-fold detail.
   */
  private walkForwardResult(
    spec: { key: string; plugin: StrategyPlugin; config: StrategyConfig },
    res: WalkForwardResult,
  ) {
    const reasons: Record<string, number> = {};
    const decisions = { evaluated: 0, trades: 0, noTrades: 0, errors: 0, reasons };
    for (const f of res.folds) {
      decisions.evaluated += f.testDecisions.evaluated;
      decisions.trades += f.testDecisions.trades;
      decisions.noTrades += f.testDecisions.noTrades;
      decisions.errors += f.testDecisions.errors;
      for (const [k, v] of Object.entries(f.testDecisions.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
    }
    return {
      results: [
        this.summarize({
          key: `${spec.key} (walk-forward, out of sample)`,
          pluginId: spec.plugin.id,
          config: spec.config,
          report: res.outOfSample,
          decisions,
          entries: res.entries,
        }),
      ],
      walkForward: {
        candidates: res.candidates,
        selectionStability: res.selectionStability,
        folds: res.folds.map(({ testDecisions: _d, ...f }) => f),
      },
    };
  }

  private summarize(r: BacktestStrategyResult) {
    return {
      key: r.key,
      pluginId: r.pluginId,
      config: r.config,
      decisions: r.decisions,
      summary: r.report.summary,
      byDirection: r.report.byDirection,
      daily: r.report.daily,
      weekly: r.report.weekly,
      monthly: r.report.monthly,
      equity: downsample(r.report.equity, EQUITY_POINTS),
      returnsHistogram: r.report.returnsHistogram,
      stakeHistogram: r.report.stakeHistogram,
      capitalUtilization: r.report.capitalUtilization,
      sampleTrades: r.entries.slice(-SAMPLE_TRADES),
    };
  }
}
