/**
 * Built-in strategy plugins. The first two are ports of the strategies shipped in bsc-predict-bot
 * (whose README warns they are demonstrations that lose money); they remain demonstrations here.
 */
import type { RoundView } from '../round.js';
import type { Signal, StrategyPlugin } from './types.js';

const skip = (rationale: string, indicators?: Signal['indicators']): Signal => ({
  action: 'SKIP',
  confidence: 0,
  rationale,
  ...(indicators ? { indicators } : {}),
});

const ended = (history: readonly RoundView[]) =>
  history.filter((r) => r.outcome !== null && r.outcome !== 'CANCELLED');

type FollowParams = { invert: boolean };

/** Port of bsc-predict-bot strategies/SimpleBot.py: bet the winner of the latest completed round. */
export const followLastWinner: StrategyPlugin<FollowParams> = {
  id: 'follow-last-winner',
  name: 'Follow last winner',
  version: '1.0.0',
  description:
    'Port of bsc-predict-bot SimpleBot: bets the direction that won the most recent completed (oracle-called) round. ' +
    'Skips when that round was a tie. Demonstration strategy.',
  params: [
    {
      key: 'invert',
      label: 'Invert',
      type: 'boolean',
      description: 'Bet against the last winner instead of with it.',
    },
  ],
  defaults: { invert: false },
  lookback: () => 10,
  evaluate(ctx, p) {
    const last = ended(ctx.history).at(-1);
    if (!last) return skip('no completed round in history yet');
    if (last.outcome === 'TIE')
      return skip(`last completed round #${last.epoch} was a tie`, { lastEpoch: last.epoch });
    const follow = last.outcome === 'BULL' ? 'BUY_UP' : 'BUY_DOWN';
    const action = p.invert ? (follow === 'BUY_UP' ? 'BUY_DOWN' : 'BUY_UP') : follow;
    return {
      action,
      confidence: 0.5,
      rationale: `last completed round #${last.epoch} was ${last.outcome}${p.invert ? ' (inverted)' : ''}`,
      indicators: { lastEpoch: last.epoch, lastOutcome: last.outcome ?? null },
    };
  },
};

type MomentumParams = { window: number; minMovePct: number };

/**
 * Port of bsc-predict-bot strategies/TrendingBot.py. The original looked at the last 5 Chainlink prints;
 * this version uses the close prices of the last N completed rounds so it can be backtested with the
 * exact same inputs it sees live (oracle prints between rounds are not in the historical dataset).
 * Semantics kept: "bullish" = no step down, "bearish" = no step up. A flat series is skipped (the
 * original returned BULL for a flat series).
 */
export const momentum: StrategyPlugin<MomentumParams> = {
  id: 'momentum',
  name: 'Close-price momentum',
  version: '1.0.0',
  description:
    'Port of bsc-predict-bot TrendingBot: bets with the trend when the last N round close prices never step ' +
    'against it. Demonstration strategy.',
  params: [
    {
      key: 'window',
      label: 'Window (rounds)',
      type: 'integer',
      min: 3,
      max: 50,
      description: 'Close prices to inspect.',
    },
    {
      key: 'minMovePct',
      label: 'Minimum move %',
      type: 'number',
      min: 0,
      max: 10,
      step: 0.01,
      description: 'Minimum total move across the window, in percent.',
    },
  ],
  defaults: { window: 5, minMovePct: 0 },
  lookback: (p) => p.window + 10,
  evaluate(ctx, p) {
    const closes = ended(ctx.history)
      .map((r) => r.closePrice)
      .filter((v): v is number => v !== null)
      .slice(-p.window);
    if (closes.length < p.window) return skip(`need ${p.window} completed rounds, have ${closes.length}`);
    let bullish = true;
    let bearish = true;
    for (let i = 1; i < closes.length; i++) {
      if (closes[i]! < closes[i - 1]!) bullish = false;
      else if (closes[i]! > closes[i - 1]!) bearish = false;
    }
    const first = closes[0]!;
    const last = closes.at(-1)!;
    const movePct = ((last - first) / first) * 100;
    const indicators = { movePct: Number(movePct.toFixed(4)), first, last, bullish, bearish };
    if (bullish && bearish) return skip('flat price series', indicators);
    if (Math.abs(movePct) < p.minMovePct)
      return skip(`move ${movePct.toFixed(3)}% below ${p.minMovePct}%`, indicators);
    if (bullish)
      return {
        action: 'BUY_UP',
        confidence: 0.5,
        rationale: `${p.window} closes trending up (${movePct.toFixed(3)}%)`,
        indicators,
      };
    if (bearish)
      return {
        action: 'BUY_DOWN',
        confidence: 0.5,
        rationale: `${p.window} closes trending down (${movePct.toFixed(3)}%)`,
        indicators,
      };
    return skip('no monotonic trend', indicators);
  },
};

type StreakParams = { streak: number; mode: string };

/** Bets against (FADE) or with (FOLLOW) a run of identical outcomes. */
export const streakReversal: StrategyPlugin<StreakParams> = {
  id: 'streak-reversal',
  name: 'Streak reversal',
  version: '1.0.0',
  description:
    'Counts consecutive identical outcomes among completed rounds (ties break a run, cancelled rounds are ignored). ' +
    'After a run of at least N, bets against it (FADE) or with it (FOLLOW).',
  params: [
    {
      key: 'streak',
      label: 'Run length',
      type: 'integer',
      min: 2,
      max: 20,
      description: 'Minimum run length.',
    },
    {
      key: 'mode',
      label: 'Mode',
      type: 'enum',
      options: ['FADE', 'FOLLOW'],
      description: 'Bet against or with the run.',
    },
  ],
  defaults: { streak: 4, mode: 'FADE' },
  lookback: (p) => p.streak + 20,
  evaluate(ctx, p) {
    const outcomes = ended(ctx.history).map((r) => r.outcome);
    const last = outcomes.at(-1);
    if (last === undefined) return skip('no completed round in history yet');
    if (last === 'TIE') return skip('last completed round was a tie');
    let run = 0;
    for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === last; i--) run++;
    const indicators = { run, runDirection: last ?? null };
    if (run < p.streak) return skip(`run of ${run} ${last} below ${p.streak}`, indicators);
    const withRun = last === 'BULL' ? 'BUY_UP' : 'BUY_DOWN';
    const action = p.mode === 'FOLLOW' ? withRun : withRun === 'BUY_UP' ? 'BUY_DOWN' : 'BUY_UP';
    return {
      action,
      confidence: 0.5,
      rationale: `${run} consecutive ${last} rounds (${p.mode})`,
      indicators,
    };
  },
};

type ManualParams = { direction: string };

/** Used for operator orders from the dashboard so they pass through the same sizing/risk/execution path. */
export const manualOrder: StrategyPlugin<ManualParams> = {
  id: 'manual',
  name: 'Manual order',
  version: '1.0.0',
  description:
    'Operator-placed order from the dashboard. Goes through the same risk checks and execution engine.',
  params: [
    {
      key: 'direction',
      label: 'Direction',
      type: 'enum',
      options: ['BULL', 'BEAR'],
      description: 'Side to bet.',
    },
  ],
  defaults: { direction: 'BULL' },
  lookback: () => 1,
  evaluate(_ctx, p) {
    return {
      action: p.direction === 'BEAR' ? 'BUY_DOWN' : 'BUY_UP',
      confidence: 1,
      rationale: `manual ${p.direction} order`,
    };
  },
};

export const BUILTIN_STRATEGIES: readonly StrategyPlugin[] = [
  followLastWinner as StrategyPlugin,
  momentum as StrategyPlugin,
  streakReversal as StrategyPlugin,
];

export function getPlugin(id: string): StrategyPlugin | undefined {
  if (id === manualOrder.id) return manualOrder as StrategyPlugin;
  return BUILTIN_STRATEGIES.find((p) => p.id === id);
}
