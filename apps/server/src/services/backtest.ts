/** Backtests over the canonical rounds table using the core replay engine (same decide() as live). */
import type { BacktestStrategyResult, StrategyConfig, StrategyPlugin } from '@bsc/core';
import {
  BacktestRunner,
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
  start(input: unknown): number {
    const req = BacktestRequestSchema.parse(input);
    if (this.active !== null) throw new BacktestInputError(`backtest #${this.active} is still running`);
    if (req.to <= req.from) throw new BacktestInputError('"to" must be after "from"');
    const { repos, config } = this.ctx;
    const market = req.marketId ? repos.markets.get(req.marketId) : this.markets.tradable();
    if (!market) throw new BacktestInputError('unknown market');
    if (market.timing !== 'TIMESTAMP')
      throw new BacktestInputError(`${market.slug} has no round timestamps and cannot be replayed`);

    const specs = req.strategies.map((s, i) => {
      let plugin: StrategyPlugin | undefined;
      let base: StrategyConfig;
      let key: string;
      if (s.strategyId !== undefined) {
        const row = repos.strategies.get(s.strategyId);
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
      return {
        key:
          req.strategies.filter((x, j) => j < i && (x.label ?? x.plugin) === key).length > 0
            ? `${key}#${i + 1}`
            : key,
        plugin,
        config: parsed.value,
      };
    });

    const rounds = repos.rounds.finalForBacktest(market.id, req.from, req.to);
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
    const runner = new BacktestRunner({
      market: market.slug,
      rounds,
      strategies: specs,
      startingBankrollWei: bnbToWei(req.startingBankrollBnb),
      gasPerBetWei,
      gasPerClaimWei,
      treasuryFeeBps: market.treasuryFeeBps,
      minBetWei: market.minBetWei ?? bnbToWei('0.001'),
      bufferSeconds: market.bufferSeconds ?? 30,
      globalLimits,
    });

    const runId = repos.backtests.create(req);
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
      assumptions: [
        'Each strategy decides at lockTime − entrySecondsBeforeLock using only rounds final at that time.',
        'The betting round pool and oracle price are not visible (they are unknown before lock in the dataset).',
        'Payouts use the contract formula with the simulated stake added to the recorded pool (own dilution modelled).',
        'Gas per bet and per claim are fixed assumptions; ties lose, cancelled rounds refund the stake.',
        market.protocol === 'PRDT' ? 'PRDT referral bonuses are not modelled.' : null,
      ].filter(Boolean),
    };

    this.runPromise = (async () => {
      try {
        while (!runner.done) {
          if (this.aborted) throw new Error('aborted: process shutting down');
          runner.step(STEP);
          const progress = runner.processed / runner.total;
          repos.backtests.progress(runId, progress);
          this.ctx.bus.emit('backtest', { id: runId, status: 'RUNNING', progress });
          await new Promise((r) => setImmediate(r));
        }
        const results = runner.results().map((r) => this.summarize(r));
        repos.backtests.finish(runId, { ...meta, results }, Date.now() - started);
        this.ctx.bus.emit('backtest', { id: runId, status: 'DONE', progress: 1 });
      } catch (err) {
        repos.backtests.fail(runId, errorMessage(err));
        this.ctx.log.app.error({ err, runId }, 'backtest failed');
        this.ctx.bus.emit('backtest', { id: runId, status: 'FAILED', error: errorMessage(err) });
      } finally {
        this.active = null;
      }
    })();
    return runId;
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
