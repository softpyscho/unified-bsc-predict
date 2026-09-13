/**
 * Historical replay. Runs the exact decide() pipeline used live, with a simulated execution adapter.
 *
 * Time model per betting round R (epoch n):
 *   decision time  t = R.lockTime − entrySecondsBeforeLock
 *   pending trades settle when their result is knowable (close, or close + buffer for cancellations) ≤ t,
 *   so a trade on round n−1 is still at risk (exposure) when deciding round n — just like live.
 * The betting round's pool is hidden (it is only known at lock), and no oracle price is provided.
 */
import type { LedgerEntry, PortfolioReport } from './portfolio.js';
import { computePortfolio, utcDay } from './portfolio.js';
import type { RiskLimits } from './risk.js';
import { mergeLimits } from './risk.js';
import type { FinalRound } from './round.js';
import { simulatedPayout } from './round.js';
import type { StrategyConfig } from './strategy/config.js';
import { strategyLimitOverrides } from './strategy/config.js';
import { buildContext } from './strategy/context.js';
import { decide, lookbackFor } from './strategy/pipeline.js';
import type { StrategyPlugin } from './strategy/types.js';
import { resultFor, tradeNetPnl } from './trade.js';

export interface BacktestStrategySpec {
  key: string;
  plugin: StrategyPlugin;
  config: StrategyConfig;
}

export interface BacktestOptions {
  market: string;
  rounds: readonly FinalRound[];
  strategies: readonly BacktestStrategySpec[];
  startingBankrollWei: bigint;
  gasPerBetWei: bigint;
  gasPerClaimWei: bigint;
  treasuryFeeBps: number;
  minBetWei: bigint;
  bufferSeconds: number;
  globalLimits: RiskLimits;
}

export interface BacktestStrategyResult {
  key: string;
  pluginId: string;
  config: StrategyConfig;
  report: PortfolioReport;
  decisions: {
    evaluated: number;
    trades: number;
    noTrades: number;
    errors: number;
    reasons: Record<string, number>;
  };
  entries: LedgerEntry[];
}

interface Pending {
  entry: LedgerEntry;
  round: FinalRound;
  knownAt: number;
}

interface SimState {
  spec: BacktestStrategySpec;
  limits: RiskLimits;
  lookback: number;
  cash: bigint;
  exposure: bigint;
  pending: Pending[];
  entries: LedgerEntry[];
  lossStreak: number;
  lastLossEpoch: number | null;
  daily: Map<string, bigint>;
  netPnl: bigint;
  evaluated: number;
  trades: number;
  errors: number;
  reasons: Map<string, number>;
}

export class BacktestRunner {
  private index = 0;
  private readonly states: SimState[];
  private finished = false;

  constructor(private readonly opts: BacktestOptions) {
    for (let i = 1; i < opts.rounds.length; i++) {
      if (opts.rounds[i]!.epoch <= opts.rounds[i - 1]!.epoch)
        throw new Error('rounds must be sorted by ascending epoch');
    }
    this.states = opts.strategies.map((spec) => ({
      spec,
      limits: mergeLimits(opts.globalLimits, strategyLimitOverrides(spec.config)),
      lookback: lookbackFor(spec.plugin, spec.config),
      cash: opts.startingBankrollWei,
      exposure: 0n,
      pending: [],
      entries: [],
      lossStreak: 0,
      lastLossEpoch: null,
      daily: new Map(),
      netPnl: 0n,
      evaluated: 0,
      trades: 0,
      errors: 0,
      reasons: new Map(),
    }));
  }

  get total(): number {
    return this.opts.rounds.length;
  }

  get processed(): number {
    return this.index;
  }

  get done(): boolean {
    return this.finished;
  }

  /** Processes up to `maxRounds` betting rounds; call repeatedly (allows the caller to yield). */
  step(maxRounds: number): void {
    const rounds = this.opts.rounds;
    const end = Math.min(this.index + maxRounds, rounds.length);
    for (; this.index < end; this.index++) {
      const round = rounds[this.index]!;
      if (round.startTime === null || round.lockTime === null || round.closeTime === null) continue;
      for (const state of this.states) this.evaluate(state, this.index, round);
    }
    if (this.index >= rounds.length && !this.finished) {
      for (const state of this.states) this.settleUpTo(state, Number.POSITIVE_INFINITY);
      this.finished = true;
    }
  }

  runToEnd(): BacktestStrategyResult[] {
    while (!this.done) this.step(10_000);
    return this.results();
  }

  results(): BacktestStrategyResult[] {
    return this.states.map((s) => ({
      key: s.spec.key,
      pluginId: s.spec.plugin.id,
      config: s.spec.config,
      report: computePortfolio(s.entries, { startingBankroll: this.opts.startingBankrollWei }),
      decisions: {
        evaluated: s.evaluated,
        trades: s.trades,
        noTrades: s.evaluated - s.trades,
        errors: s.errors,
        reasons: Object.fromEntries([...s.reasons].sort((a, b) => b[1] - a[1])),
      },
      entries: s.entries,
    }));
  }

  private settleUpTo(state: SimState, t: number): void {
    if (state.pending.length === 0) return;
    const remaining: Pending[] = [];
    for (const p of state.pending) {
      if (p.knownAt <= t) this.settle(state, p);
      else remaining.push(p);
    }
    state.pending = remaining;
  }

  private settle(state: SimState, p: Pending): void {
    const { entry, round } = p;
    const payout = simulatedPayout(
      round,
      round.outcome,
      entry.direction,
      entry.amount,
      this.opts.treasuryFeeBps,
    );
    const result = resultFor(round.outcome, entry.direction);
    const claimGas = result === 'LOST' ? 0n : this.opts.gasPerClaimWei;
    state.cash += payout - claimGas;
    state.exposure -= entry.amount;
    entry.status = 'SETTLED';
    entry.result = result;
    entry.payout = payout;
    entry.claimGasCost = claimGas;
    entry.settledAt = p.knownAt;
    const net = tradeNetPnl(entry) ?? 0n;
    state.netPnl += net;
    const day = utcDay(p.knownAt);
    state.daily.set(day, (state.daily.get(day) ?? 0n) + net);
    if (result === 'WON') state.lossStreak = 0;
    else if (result === 'LOST') {
      state.lossStreak++;
      state.lastLossEpoch = entry.epoch;
    }
  }

  private evaluate(state: SimState, index: number, round: FinalRound): void {
    const { opts } = this;
    const lockTime = round.lockTime!;
    const startTime = round.startTime!;
    const now = Math.max(startTime, lockTime - state.spec.config.timing.entrySecondsBeforeLock);
    this.settleUpTo(state, now);

    const prev = index > 0 ? opts.rounds[index - 1]! : null;
    const bankroll = state.cash + state.exposure;
    const ctx = buildContext({
      mode: 'BACKTEST',
      now,
      betting: { epoch: round.epoch, startTime, lockTime, pool: null },
      live: prev && prev.epoch === round.epoch - 1 ? prev : null,
      history: opts.rounds,
      historyEnd: index,
      lookback: state.lookback,
      price: null,
      bankrollWei: bankroll,
      treasuryFeeBps: opts.treasuryFeeBps,
      bufferSeconds: opts.bufferSeconds,
    });

    const decision = decide({
      mode: 'BACKTEST',
      plugin: state.spec.plugin,
      config: state.spec.config,
      ctx,
      limits: state.limits,
      state: {
        bankrollWei: bankroll,
        availableWei: state.cash,
        exposureWei: state.exposure,
        dailyNetPnlWei: state.daily.get(utcDay(now)) ?? 0n,
        strategyNetPnlWei: state.netPnl,
        lossStreak: state.lossStreak,
        roundsSinceLastLoss: state.lastLossEpoch === null ? null : round.epoch - state.lastLossEpoch,
        alreadyBetThisRound: false,
        roundOpen: true,
        secondsToLock: lockTime - now,
        gasPriceWei: null,
        gasReserveWei: opts.gasPerBetWei,
      },
      gates: [],
      minBetWei: opts.minBetWei,
    });

    state.evaluated++;
    if (decision.error !== null) state.errors++;
    if (decision.kind !== 'TRADE' || decision.stakeWei === null || decision.direction === null) {
      const code =
        decision.kind === 'WAIT'
          ? 'WAIT_AT_DECISION_TIME'
          : decision.reason.startsWith('RISK_REJECTED')
            ? `RISK_REJECTED:${decision.reason.split(':')[1]?.trim() ?? ''}`
            : (decision.reason.split(':')[0] ?? decision.reason);
      state.reasons.set(code, (state.reasons.get(code) ?? 0) + 1);
      return;
    }

    const entry: LedgerEntry = {
      id: `${state.spec.key}:${round.epoch}`,
      mode: 'BACKTEST',
      epoch: round.epoch,
      placedAt: now,
      settledAt: null,
      strategy: state.spec.key,
      market: opts.market,
      direction: decision.direction,
      amount: decision.stakeWei,
      status: 'CONFIRMED',
      result: null,
      payout: null,
      gasCost: opts.gasPerBetWei,
      claimGasCost: null,
    };
    state.trades++;
    state.cash -= decision.stakeWei + opts.gasPerBetWei;
    state.exposure += decision.stakeWei;
    state.entries.push(entry);
    const closeTime = round.closeTime!;
    state.pending.push({
      entry,
      round,
      knownAt: round.outcome === 'CANCELLED' ? closeTime + opts.bufferSeconds : closeTime,
    });
  }
}
