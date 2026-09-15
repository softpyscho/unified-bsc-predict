/**
 * Walk-forward validation. In each fold a configuration is chosen from a parameter grid using only the training
 * window, then traded unchanged on the following, unseen test window. The concatenated test ledgers measure the
 * whole tuning procedure out of sample: the honest answer to "would tuning this strategy have made money?".
 *
 * Every fold starts from the same bankroll and with no own-trade history (a recovery ladder starts at step 1);
 * the combined report sums the folds' P&L exactly, so its bankroll path is an approximation.
 */
import type { BacktestOptions, BacktestStrategyResult, BacktestStrategySpec } from './backtest.js';
import { BacktestRunner } from './backtest.js';
import type { LedgerEntry, PerformanceSummary, PortfolioReport } from './portfolio.js';
import { computePortfolio } from './portfolio.js';
import type { StrategyConfig } from './strategy/config.js';
import { parseStrategyConfig } from './strategy/config.js';
import type { ParamValue, ParamValues } from './strategy/params.js';
import { lookbackFor } from './strategy/pipeline.js';
import type { StrategyPlugin } from './strategy/types.js';

export const MAX_WALK_FORWARD_CANDIDATES = 64;

export interface WalkForwardOptions extends Omit<BacktestOptions, 'strategies' | 'tradeFromEpoch'> {
  plugin: StrategyPlugin;
  base: StrategyConfig;
  /** Values to search per parameter; every combination is a candidate. Empty: the base configuration only. */
  grid: Readonly<Record<string, readonly ParamValue[]>>;
  trainRounds: number;
  testRounds: number;
  /** Rounds between fold starts (default `testRounds`: back-to-back, non-overlapping test windows). */
  stepRounds?: number;
  /** Every training window starts at the first round (expanding) instead of rolling. */
  anchored?: boolean;
  /** How a fold picks its candidate on the training window (default net P&L). */
  objective?: 'netPnl' | 'roi';
}

export interface WalkForwardFold {
  index: number;
  trainFromEpoch: number;
  trainToEpoch: number;
  testFromEpoch: number;
  testToEpoch: number;
  chosen: ParamValues;
  chosenIndex: number;
  train: PerformanceSummary;
  test: PerformanceSummary;
  testDecisions: BacktestStrategyResult['decisions'];
  candidates: { params: ParamValues; netPnl: bigint; roi: number | null; trades: number }[];
}

export interface WalkForwardResult {
  candidates: ParamValues[];
  folds: WalkForwardFold[];
  /** All test windows combined: the out-of-sample record of the tuning procedure. */
  outOfSample: PortfolioReport;
  /** The out-of-sample trades behind `outOfSample`. */
  entries: LedgerEntry[];
  /** Share of consecutive folds that chose the same candidate (null with one fold). Low = noise-fitting. */
  selectionStability: number | null;
}

/** Cartesian product of the grid over `base`; keys not in the grid keep their base value. */
export function expandGrid(
  base: ParamValues,
  grid: Readonly<Record<string, readonly ParamValue[]>>,
): ParamValues[] {
  let out: ParamValues[] = [{ ...base }];
  for (const [key, values] of Object.entries(grid)) {
    if (values.length === 0) continue;
    out = out.flatMap((p) => values.map((v) => ({ ...p, [key]: v })));
  }
  return out;
}

interface Fold {
  trainStart: number;
  trainEnd: number;
  testEnd: number;
}

export class WalkForwardRunner {
  private readonly candidates: { params: ParamValues; config: StrategyConfig }[];
  private readonly folds: Fold[] = [];
  /** History rounds loaded before each window so strategies see their full lookback. */
  private readonly warm: number;
  private foldIndex = 0;
  private phase: 'train' | 'test' = 'train';
  private runner: BacktestRunner | null = null;
  private trainResults: BacktestStrategyResult[] = [];
  private chosenIndex = 0;
  private readonly out: WalkForwardFold[] = [];
  private readonly oosEntries: LedgerEntry[] = [];
  private finished = false;

  constructor(private readonly opts: WalkForwardOptions) {
    const { rounds, trainRounds, testRounds } = opts;
    const stepRounds = opts.stepRounds ?? testRounds;
    if (!Number.isInteger(trainRounds) || trainRounds < 10)
      throw new Error('trainRounds must be an integer of at least 10');
    if (!Number.isInteger(testRounds) || testRounds < 1)
      throw new Error('testRounds must be a positive integer');
    if (!Number.isInteger(stepRounds) || stepRounds < testRounds)
      throw new Error('stepRounds must be at least testRounds, so test windows never overlap');
    const combos = expandGrid(opts.base.params, opts.grid);
    if (combos.length > MAX_WALK_FORWARD_CANDIDATES)
      throw new Error(`${combos.length} parameter combinations (max ${MAX_WALK_FORWARD_CANDIDATES})`);
    this.candidates = combos.map((params, i) => {
      const parsed = parseStrategyConfig(opts.plugin, { ...opts.base, params });
      if (!parsed.ok)
        throw new Error(`candidate ${i + 1} ${JSON.stringify(params)}: ${parsed.errors.join('; ')}`);
      return { params: parsed.value.params, config: parsed.value };
    });
    this.warm = Math.max(...this.candidates.map((c) => lookbackFor(opts.plugin, c.config))) + 2;
    for (let start = 0; ; start += stepRounds) {
      const trainEnd = start + trainRounds;
      const testEnd = trainEnd + testRounds;
      if (testEnd > rounds.length) break;
      this.folds.push({ trainStart: opts.anchored ? 0 : start, trainEnd, testEnd });
    }
    if (this.folds.length === 0)
      throw new Error(
        `${rounds.length} rounds are not enough for one fold of ${trainRounds} + ${testRounds}`,
      );
  }

  get foldCount(): number {
    return this.folds.length;
  }

  /** Strategies replayed side by side in each training window (callers can size their work chunks by it). */
  get candidateCount(): number {
    return this.candidates.length;
  }

  get done(): boolean {
    return this.finished;
  }

  /** 0..1 across all folds (each fold is a training replay and a test replay). */
  get progress(): number {
    if (this.finished) return 1;
    const within = this.runner ? this.runner.processed / Math.max(1, this.runner.total) : 0;
    return (this.foldIndex * 2 + (this.phase === 'test' ? 1 : 0) + within) / (this.folds.length * 2);
  }

  /** Processes about `maxRounds` round evaluations; call repeatedly (lets the caller yield). */
  step(maxRounds: number): void {
    let budget = maxRounds;
    while (budget > 0 && !this.finished) {
      this.runner ??= this.startJob();
      const before = this.runner.processed;
      this.runner.step(budget);
      budget -= Math.max(1, this.runner.processed - before);
      if (this.runner.done) {
        this.completeJob(this.runner.results());
        this.runner = null;
      }
    }
  }

  runToEnd(): WalkForwardResult {
    while (!this.finished) this.step(50_000);
    return this.result();
  }

  result(): WalkForwardResult {
    const chosen = this.out.map((f) => f.chosenIndex);
    const same = chosen.slice(1).filter((c, i) => c === chosen[i]).length;
    return {
      candidates: this.candidates.map((c) => c.params),
      folds: this.out,
      outOfSample: computePortfolio(this.oosEntries, { startingBankroll: this.opts.startingBankrollWei }),
      entries: [...this.oosEntries],
      selectionStability: this.out.length > 1 ? same / (this.out.length - 1) : null,
    };
  }

  private backtest(from: number, to: number, strategies: BacktestStrategySpec[]): BacktestRunner {
    const o = this.opts;
    return new BacktestRunner({
      market: o.market,
      rounds: o.rounds.slice(Math.max(0, from - this.warm), to),
      strategies,
      startingBankrollWei: o.startingBankrollWei,
      gasPerBetWei: o.gasPerBetWei,
      gasPerClaimWei: o.gasPerClaimWei,
      treasuryFeeBps: o.treasuryFeeBps,
      minBetWei: o.minBetWei,
      bufferSeconds: o.bufferSeconds,
      globalLimits: o.globalLimits,
      tradeFromEpoch: o.rounds[from]!.epoch,
    });
  }

  private startJob(): BacktestRunner {
    const f = this.folds[this.foldIndex]!;
    if (this.phase === 'train')
      return this.backtest(
        f.trainStart,
        f.trainEnd,
        this.candidates.map((c, i) => ({ key: `c${i}`, plugin: this.opts.plugin, config: c.config })),
      );
    return this.backtest(f.trainEnd, f.testEnd, [
      { key: 'oos', plugin: this.opts.plugin, config: this.candidates[this.chosenIndex]!.config },
    ]);
  }

  private completeJob(results: BacktestStrategyResult[]): void {
    if (this.phase === 'train') {
      this.trainResults = results;
      this.chosenIndex = this.pick(results);
      this.phase = 'test';
      return;
    }
    const f = this.folds[this.foldIndex]!;
    const r = this.opts.rounds;
    const test = results[0]!;
    this.oosEntries.push(...test.entries.map((e) => ({ ...e, id: `f${this.foldIndex}:${e.epoch}` })));
    this.out.push({
      index: this.foldIndex,
      trainFromEpoch: r[f.trainStart]!.epoch,
      trainToEpoch: r[f.trainEnd - 1]!.epoch,
      testFromEpoch: r[f.trainEnd]!.epoch,
      testToEpoch: r[f.testEnd - 1]!.epoch,
      chosen: this.candidates[this.chosenIndex]!.params,
      chosenIndex: this.chosenIndex,
      train: this.trainResults[this.chosenIndex]!.report.summary,
      test: test.report.summary,
      testDecisions: test.decisions,
      candidates: this.trainResults.map((c, i) => ({
        params: this.candidates[i]!.params,
        netPnl: c.report.summary.netPnl,
        roi: c.report.summary.roi,
        trades: c.report.summary.settledTrades,
      })),
    });
    this.foldIndex++;
    this.phase = 'train';
    this.trainResults = [];
    if (this.foldIndex >= this.folds.length) this.finished = true;
  }

  /** Best candidate on the training window; ties go to the earlier grid entry. */
  private pick(results: readonly BacktestStrategyResult[]): number {
    let best = 0;
    for (let i = 1; i < results.length; i++) {
      const a = results[i]!.report.summary;
      const b = results[best]!.report.summary;
      const better =
        this.opts.objective === 'roi' ? (a.roi ?? -Infinity) > (b.roi ?? -Infinity) : a.netPnl > b.netPnl;
      if (better) best = i;
    }
    return best;
  }
}
