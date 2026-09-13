/**
 * Sequence-aware strategies: persistence, reversal, alternation, transition/Markov models, an ensemble, and the
 * configurable recovery ladder. Every probability here is *measured* from `ctx.history` fresh on each call —
 * nothing is hard-coded as "the second round is usually opposite" or "UP tends to follow UP". A pattern that
 * looks compelling on a handful of recent rounds but lacks a large historical sample is reported as such
 * (`sampleSize`) and the strategy SKIPs rather than acts on it; see docs/STRATEGIES.md.
 *
 * The recovery ladder (`sequenceRecovery`) needs no separate state table: its ladder position, the direction
 * it lost on, and whether it is mid-confirmation are all re-derived, deterministically, from `ctx.ownTrades`
 * (this strategy's own persisted trade history) every time `evaluate` runs — so it recovers its exact state
 * after a process restart for free, and stays a pure function of context like every other plugin here.
 */
import type { Direction } from '../round.js';
import {
  alternationContinuationEstimate,
  alternationLength,
  buildNGramTable,
  contextKey,
  currentStreak,
  estimateFor,
  formatSequence,
  lastTransition,
  opposite,
  persistenceEstimate,
  streakContinuationEstimate,
  toSequence,
  transitionMatrix1,
  transitionMatrix2,
} from '../sequence.js';
import type { IndicatorValue, Signal, StrategyContext, StrategyPlugin } from './types.js';

/**
 * `sequence.ts`'s return types (TransitionMatrix1, etc.) are fixed-shape interfaces without an index
 * signature, which TypeScript won't structurally match against `IndicatorValue`'s open index signature even
 * though the runtime value is plain JSON. This is a narrow, deliberate escape hatch for that mismatch only.
 */
const asIndicator = (v: unknown): IndicatorValue => v as IndicatorValue;

const skip = (rationale: string, indicators?: Signal['indicators']): Signal => ({
  action: 'SKIP',
  confidence: 0,
  rationale,
  ...(indicators ? { indicators } : {}),
});

const buyDirection = (d: Direction): 'BUY_UP' | 'BUY_DOWN' => (d === 'BULL' ? 'BUY_UP' : 'BUY_DOWN');
const pct = (x: number | null, dp = 1): string => (x === null ? 'n/a' : `${(x * 100).toFixed(dp)}%`);
const seqOf = (ctx: StrategyContext) => toSequence(ctx.history);

// ================================================================================================= persistence

type PersistenceParams = { order: number; minSampleSize: number; minEdge: number };

/**
 * Section 3: tests P(next = same | last N identical), for a configurable run length N — never assumes UP
 * tends to follow UP. Requires both a minimum sample size and a minimum edge over the 50% coin-flip baseline.
 */
export const persistence: StrategyPlugin<PersistenceParams> = {
  id: 'persistence',
  name: 'Directional persistence',
  version: '1.0.0',
  description:
    'Measures P(next round = same direction | last N rounds were all that direction) from history, for a ' +
    'configurable N. Bets only when the sample is large enough and the measured edge over 50% clears the ' +
    'configured threshold; otherwise skips.',
  params: [
    {
      key: 'order',
      label: 'Run length (N)',
      type: 'integer',
      min: 1,
      max: 8,
      description: 'Trailing identical outcomes to condition on.',
    },
    {
      key: 'minSampleSize',
      label: 'Min sample size',
      type: 'integer',
      min: 5,
      max: 20_000,
      description: 'Minimum historical occurrences of this exact context.',
    },
    {
      key: 'minEdge',
      label: 'Min edge over 50%',
      type: 'number',
      min: 0,
      max: 0.4,
      step: 0.01,
      description: 'Required |P − 0.5| before betting.',
    },
  ],
  defaults: { order: 1, minSampleSize: 30, minEdge: 0.03 },
  lookback: (p) => Math.max(300, p.order * 100),
  evaluate(ctx, p) {
    const { directions } = seqOf(ctx);
    const est = persistenceEstimate(directions, p.order);
    if (!est) return skip(`trailing streak shorter than the configured run length (${p.order})`);
    const indicators = {
      direction: est.direction,
      pSame: est.pSame,
      pOpposite: est.pOpposite,
      sampleSize: est.sampleSize,
      order: p.order,
      recentSequence: formatSequence(directions),
    };
    if (est.sampleSize < p.minSampleSize) {
      return skip(
        `only ${est.sampleSize} historical occurrences of ${p.order}× ${est.direction} (need ${p.minSampleSize})`,
        indicators,
      );
    }
    const pSame = est.pSame!;
    const edge = pSame - 0.5;
    if (Math.abs(edge) < p.minEdge)
      return skip(`measured edge ${pct(edge)} below the ${pct(p.minEdge)} threshold`, indicators);
    const bet = edge > 0 ? est.direction : opposite(est.direction);
    const confidence = edge > 0 ? pSame : 1 - pSame;
    return {
      action: buyDirection(bet),
      confidence,
      rationale: `after ${p.order}× ${est.direction}, history shows P(continue)=${pct(pSame)} (n=${est.sampleSize})`,
      indicators,
    };
  },
};

// ==================================================================================================== reversal

type ReversalParams = { minPreviousRun: number; minSampleSize: number; minEdge: number };

/**
 * Section 4: at the moment a run of at least `minPreviousRun` just broke, measures whether the market
 * historically tends to continue the new direction (A→B→B) or snap back (A→B→A) — both hypotheses are
 * calculated, never assumed.
 */
export const reversalStrategy: StrategyPlugin<ReversalParams> = {
  id: 'reversal',
  name: 'Reversal continuation',
  version: '1.0.0',
  description:
    'Right after a run of at least N breaks, measures P(the new direction continues) vs P(it snaps back), ' +
    'from history, and bets whichever the data supports.',
  params: [
    {
      key: 'minPreviousRun',
      label: 'Min prior run length',
      type: 'integer',
      min: 1,
      max: 10,
      description: 'The broken run must be at least this long to count.',
    },
    { key: 'minSampleSize', label: 'Min sample size', type: 'integer', min: 5, max: 20_000, description: '' },
    {
      key: 'minEdge',
      label: 'Min edge over 50%',
      type: 'number',
      min: 0,
      max: 0.4,
      step: 0.01,
      description: '',
    },
  ],
  defaults: { minPreviousRun: 2, minSampleSize: 30, minEdge: 0.03 },
  lookback: () => 500,
  evaluate(ctx, p) {
    const { directions } = seqOf(ctx);
    const tail = currentStreak(directions);
    if (tail.direction === null || tail.length !== 1) {
      return skip('not the first round of a fresh direction change');
    }
    const trans = lastTransition(directions);
    if (!trans) return skip('no direction change yet in the visible history');
    if (trans.previousRunLength < p.minPreviousRun) {
      return skip(`the broken run was only ${trans.previousRunLength} long (need ${p.minPreviousRun})`);
    }
    // Order-1 persistence evaluated exactly at this fresh-transition moment: P(next = new direction).
    const est = persistenceEstimate(directions, 1)!;
    const indicators = {
      from: trans.from,
      to: trans.to,
      previousRunLength: trans.previousRunLength,
      pContinue: est.pSame,
      pRevert: est.pOpposite,
      sampleSize: est.sampleSize,
      recentSequence: formatSequence(directions),
    };
    if (est.sampleSize < p.minSampleSize)
      return skip(`only ${est.sampleSize} historical samples (need ${p.minSampleSize})`, indicators);
    const pContinue = est.pSame!;
    const edge = pContinue - 0.5;
    if (Math.abs(edge) < p.minEdge)
      return skip(`measured edge ${pct(edge)} below ${pct(p.minEdge)}`, indicators);
    const bet = edge > 0 ? trans.to : trans.from;
    return {
      action: buyDirection(bet),
      confidence: edge > 0 ? pContinue : 1 - pContinue,
      rationale: `after ${trans.previousRunLength}× ${trans.from} → ${trans.to}, history shows P(continue as ${trans.to})=${pct(pContinue)} (n=${est.sampleSize})`,
      indicators,
    };
  },
};

// ================================================================================================= alternation

type AlternationParams = {
  minAlternationLength: number;
  mode: string;
  minSampleSize: number;
  minEdge: number;
};

/**
 * Sections 13/14: when the trailing sequence has alternated (A,B,A,B,...) for at least the configured length,
 * measures whether it tends to keep alternating (CONTINUE_ALTERNATION) or, once it just broke, whether the
 * break tends to run further (BREAK_FOLLOW_THROUGH) — either way, from measured history.
 */
export const alternationStrategy: StrategyPlugin<AlternationParams> = {
  id: 'alternation',
  name: 'Alternation pattern',
  version: '1.0.0',
  description:
    'CONTINUE_ALTERNATION: after >=N alternating rounds, measures P(the pattern continues) and bets the ' +
    'opposite of the last round if the data supports it. BREAK_FOLLOW_THROUGH: after a qualifying alternation ' +
    'just broke, measures whether the break tends to run further or the alternation resumes.',
  params: [
    {
      key: 'minAlternationLength',
      label: 'Min alternation length',
      type: 'integer',
      min: 2,
      max: 12,
      description: '',
    },
    {
      key: 'mode',
      label: 'Mode',
      type: 'enum',
      options: ['CONTINUE_ALTERNATION', 'BREAK_FOLLOW_THROUGH'],
      description: '',
    },
    { key: 'minSampleSize', label: 'Min sample size', type: 'integer', min: 5, max: 20_000, description: '' },
    {
      key: 'minEdge',
      label: 'Min edge over 50%',
      type: 'number',
      min: 0,
      max: 0.4,
      step: 0.01,
      description: '',
    },
  ],
  defaults: { minAlternationLength: 3, mode: 'CONTINUE_ALTERNATION', minSampleSize: 30, minEdge: 0.03 },
  lookback: () => 500,
  evaluate(ctx, p) {
    const { directions: seq } = seqOf(ctx);
    if (p.mode === 'CONTINUE_ALTERNATION') {
      const est = alternationContinuationEstimate(seq, p.minAlternationLength);
      if (!est) return skip(`trailing alternation shorter than ${p.minAlternationLength}`);
      const indicators = { ...est, recentSequence: formatSequence(seq) };
      if (est.sampleSize < p.minSampleSize)
        return skip(`only ${est.sampleSize} historical samples (need ${p.minSampleSize})`, indicators);
      const edge = est.pContinue! - 0.5;
      if (Math.abs(edge) < p.minEdge)
        return skip(`measured edge ${pct(edge)} below ${pct(p.minEdge)}`, indicators);
      const bet = edge > 0 ? est.expected : opposite(est.expected);
      return {
        action: buyDirection(bet),
        confidence: edge > 0 ? est.pContinue! : 1 - est.pContinue!,
        rationale: `${est.length}-round alternation: history shows P(continues)=${pct(est.pContinue)} (n=${est.sampleSize})`,
        indicators,
      };
    }
    // BREAK_FOLLOW_THROUGH: the last two rounds repeat (the break), and the alternation before that repeat
    // must have qualified. A break always creates exactly a 2-run of the repeated direction, so "does it run
    // further" is precisely the order-2 streak-continuation question.
    const tail = currentStreak(seq);
    if (tail.direction === null || tail.length !== 2)
      return skip('not immediately after a two-in-a-row break');
    const priorAlternation = alternationLength(seq.slice(0, seq.length - 1));
    if (priorAlternation < p.minAlternationLength) {
      return skip(
        `the alternation before the break was only ${priorAlternation} long (need ${p.minAlternationLength})`,
      );
    }
    const est = streakContinuationEstimate(seq, 2);
    if (!est) return skip('insufficient data to evaluate the break');
    const indicators = {
      brokenAlternationLength: priorAlternation,
      breakDirection: tail.direction,
      ...est,
      recentSequence: formatSequence(seq),
    };
    if (est.sampleSize < p.minSampleSize)
      return skip(`only ${est.sampleSize} historical samples (need ${p.minSampleSize})`, indicators);
    const edge = est.pContinue! - 0.5;
    if (Math.abs(edge) < p.minEdge)
      return skip(`measured edge ${pct(edge)} below ${pct(p.minEdge)}`, indicators);
    const bet = edge > 0 ? tail.direction : opposite(tail.direction);
    return {
      action: buyDirection(bet),
      confidence: edge > 0 ? est.pContinue! : 1 - est.pContinue!,
      rationale: `${priorAlternation}-round alternation broke into ${tail.direction},${tail.direction}: history shows P(runs further)=${pct(est.pContinue)} (n=${est.sampleSize})`,
      indicators,
    };
  },
};

// =========================================================================================== transition matrix

type TransitionParams = { order: number; minSampleSize: number; minEdge: number };

/** Section 16: builds and bets from the 1st- or 2nd-order transition matrix, exposing the full matrix for the dashboard. */
export const transitionMatrixStrategy: StrategyPlugin<TransitionParams> = {
  id: 'transition-matrix',
  name: 'Transition matrix',
  version: '1.0.0',
  description:
    'Builds the empirical 1st- or 2nd-order transition matrix (P(next | current) or P(next | current, previous)) ' +
    'from history and bets the higher-probability side at the current context, when the sample and edge clear ' +
    'their thresholds. The full matrix is reported for display.',
  params: [
    {
      key: 'order',
      label: 'Order',
      type: 'integer',
      min: 1,
      max: 2,
      description: '1st- or 2nd-order transition matrix.',
    },
    { key: 'minSampleSize', label: 'Min sample size', type: 'integer', min: 5, max: 20_000, description: '' },
    {
      key: 'minEdge',
      label: 'Min edge over 50%',
      type: 'number',
      min: 0,
      max: 0.4,
      step: 0.01,
      description: '',
    },
  ],
  defaults: { order: 1, minSampleSize: 30, minEdge: 0.03 },
  lookback: () => 500,
  evaluate(ctx, p) {
    const { directions: seq } = seqOf(ctx);
    if (seq.length < p.order) return skip('not enough history yet');
    const context = seq.slice(-p.order);
    const table = buildNGramTable(seq, p.order);
    const est = estimateFor(table, context);
    const matrix = p.order === 1 ? transitionMatrix1(seq) : transitionMatrix2(seq);
    const indicators = {
      order: p.order,
      context: contextKey(context),
      pUp: est.pUp,
      pDown: est.pDown,
      sampleSize: est.sampleSize,
      matrix: asIndicator(matrix),
      recentSequence: formatSequence(seq),
    };
    if (est.sampleSize < p.minSampleSize)
      return skip(
        `only ${est.sampleSize} historical samples for this context (need ${p.minSampleSize})`,
        indicators,
      );
    const edge = (est.pUp ?? 0.5) - 0.5;
    if (Math.abs(edge) < p.minEdge)
      return skip(`measured edge ${pct(edge)} below ${pct(p.minEdge)}`, indicators);
    const bet: Direction = edge > 0 ? 'BULL' : 'BEAR';
    const confidence = bet === 'BULL' ? est.pUp! : est.pDown!;
    return {
      action: buyDirection(bet),
      confidence,
      rationale: `order-${p.order} transition matrix at context [${contextKey(context)}]: P(${bet})=${pct(confidence)} (n=${est.sampleSize})`,
      indicators,
    };
  },
};

// ===================================================================================================== markov

type MarkovParams = { order: number; minSampleSize: number; minEdge: number };

/**
 * Section 17: the generalized order-N model. Unlike `persistence` (which requires the trailing N outcomes to
 * be identical), this conditions on whatever the actual trailing N-gram is, so it captures mixed contexts like
 * [UP, DOWN, UP] that persistence cannot. Compare different N by running this plugin at several orders in a
 * backtest — the app deliberately does not assume any one order is "the" model.
 */
export const markov: StrategyPlugin<MarkovParams> = {
  id: 'markov',
  name: 'Markov (order-N)',
  version: '1.0.0',
  description:
    'Conditions on the exact trailing N-outcome context (not just uniform runs) and bets the empirically ' +
    'higher-probability next direction, subject to sample-size and edge thresholds. Compare across N rather ' +
    'than assuming one order is correct.',
  params: [
    {
      key: 'order',
      label: 'Order (N)',
      type: 'integer',
      min: 1,
      max: 6,
      description: 'Length of the conditioning context.',
    },
    { key: 'minSampleSize', label: 'Min sample size', type: 'integer', min: 5, max: 20_000, description: '' },
    {
      key: 'minEdge',
      label: 'Min edge over 50%',
      type: 'number',
      min: 0,
      max: 0.4,
      step: 0.01,
      description: '',
    },
  ],
  defaults: { order: 2, minSampleSize: 30, minEdge: 0.03 },
  lookback: (p) => Math.max(500, 2 ** (p.order + 4)),
  evaluate(ctx, p) {
    const { directions: seq } = seqOf(ctx);
    if (seq.length < p.order) return skip('not enough history yet');
    const context = seq.slice(-p.order);
    const table = buildNGramTable(seq, p.order);
    const est = estimateFor(table, context);
    const indicators = {
      order: p.order,
      context: contextKey(context),
      pUp: est.pUp,
      pDown: est.pDown,
      sampleSize: est.sampleSize,
      recentSequence: formatSequence(seq),
    };
    if (est.sampleSize < p.minSampleSize)
      return skip(
        `only ${est.sampleSize} historical samples for context [${contextKey(context)}] (need ${p.minSampleSize})`,
        indicators,
      );
    const edge = (est.pUp ?? 0.5) - 0.5;
    if (Math.abs(edge) < p.minEdge)
      return skip(`measured edge ${pct(edge)} below ${pct(p.minEdge)}`, indicators);
    const bet: Direction = edge > 0 ? 'BULL' : 'BEAR';
    const confidence = bet === 'BULL' ? est.pUp! : est.pDown!;
    return {
      action: buyDirection(bet),
      confidence,
      rationale: `order-${p.order} Markov at [${contextKey(context)}]: P(${bet})=${pct(confidence)} (n=${est.sampleSize})`,
      indicators,
    };
  },
};

// =========================================================================================== sequence recovery

type RecoveryParams = {
  initialDirection: string;
  requiredPreviousStreak: number;
  confirmationCount: number;
  confirmationAction: string;
  ladderStep1: number;
  ladderStep2: number;
  ladderStep3: number;
  ladderStep4: number;
  maxRecoverySteps: number;
  sizingMode: string;
  targetProfitPercent: number;
  recoveryCooldownRounds: number;
};

interface RecoveryStatus {
  depth: number; // consecutive settled losses since the last win (0 = fresh)
  lastLoss: { epoch: number; direction: Direction; amountBnb: number } | null;
  priorLossesBnb: number; // sum of the LOST attempts counted in `depth`
}

/**
 * Walks `ownTrades` (most-recent-first) to find how many consecutive settled losses have accumulated since
 * the last win. REFUNDED trades and still-open trades are skipped — a cancelled round or an in-flight bet
 * neither advances nor resets the ladder. This is the entire "state machine": no separate table, just this
 * pure fold over the persisted ledger, re-run every time.
 */
function recoveryStatus(ownTrades: StrategyContext['ownTrades']): RecoveryStatus {
  let depth = 0;
  let lastLoss: RecoveryStatus['lastLoss'] = null;
  let priorLossesBnb = 0;
  for (const t of ownTrades) {
    if (t.result === 'WON') break;
    if (t.result === 'LOST') {
      depth++;
      priorLossesBnb += t.amountBnb;
      if (!lastLoss) lastLoss = { epoch: t.epoch, direction: t.direction, amountBnb: t.amountBnb };
    }
    // REFUNDED or still-open (result === null): informationally transparent, keep walking.
  }
  return { depth, lastLoss, priorLossesBnb };
}

function initialSignal(
  ctx: StrategyContext,
  p: RecoveryParams,
  ended: readonly Direction[],
): { direction: Direction; confidence: number; basis: string } {
  if (p.initialDirection === 'FIXED_UP') return { direction: 'BULL', confidence: 0.5, basis: 'fixed UP' };
  if (p.initialDirection === 'FIXED_DOWN') return { direction: 'BEAR', confidence: 0.5, basis: 'fixed DOWN' };
  const last = ended.at(-1);
  if (!last) return { direction: 'BULL', confidence: 0.5, basis: 'no history yet, defaulting UP' };
  const follow = p.initialDirection === 'REVERSAL' ? opposite(last) : last;
  return {
    direction: follow,
    confidence: 0.5,
    basis: `${p.initialDirection.toLowerCase()} of last round (${last})`,
  };
}

/** Payout-aware stake: the minimum stake that would recover prior losses plus a target profit at the current pool. */
function targetRecoveryStakeBnb(
  ctx: StrategyContext,
  direction: Direction,
  priorLossesBnb: number,
  targetProfitPercent: number,
): number | null {
  const pool = ctx.betting.pool;
  const payout = pool ? (direction === 'BULL' ? pool.bullPayout : pool.bearPayout) : null;
  if (payout === null || payout <= 1) return null; // no live pool reading, or a non-viable payout
  const targetProfitBnb = ctx.bankrollBnb * (targetProfitPercent / 100);
  return (priorLossesBnb + targetProfitBnb) / (payout - 1);
}

/**
 * Sections 1–2, 5–11, 20–21, 26–28: the configurable recovery ladder. Attempt 1 picks a direction per
 * `initialDirection`. On a loss, it does NOT immediately rebet — it watches the market (via `ctx.history`) for
 * a qualifying reversal (the losing round's own outcome, by definition, already *is* the first occurrence of
 * the opposite direction) confirmed `confirmationCount` times, with the run it reversed *from* having been at
 * least `requiredPreviousStreak` long, before placing the next ladder step. After `maxRecoverySteps` losses the
 * sequence is abandoned for `recoveryCooldownRounds` rounds, then resets. Global risk limits (daily loss,
 * exposure, stake caps) are enforced independently downstream and can never be bypassed by this ladder.
 */
export const sequenceRecovery: StrategyPlugin<RecoveryParams> = {
  id: 'sequence-recovery',
  name: 'Sequence recovery ladder',
  version: '1.0.0',
  description:
    'Configurable N-step recovery ladder (default 1%/3%/6%/10% of bankroll). After a loss it waits for a ' +
    'confirmed reversal — not an immediate double-up — before re-entering, with the confirmation rule and ' +
    "ladder fully configurable. State is derived from this strategy's own trade history, so it survives a " +
    'restart with no separate state table. Demonstration strategy: backtest thoroughly before considering live.',
  params: [
    {
      key: 'initialDirection',
      label: 'Fresh-entry direction',
      type: 'enum',
      options: ['PERSISTENCE', 'REVERSAL', 'FIXED_UP', 'FIXED_DOWN'],
      description: 'How attempt 1 picks a direction when not recovering.',
    },
    {
      key: 'requiredPreviousStreak',
      label: 'Required prior run length',
      type: 'integer',
      min: 1,
      max: 10,
      description: 'The run being reversed from must be at least this long.',
    },
    {
      key: 'confirmationCount',
      label: 'Confirmation rounds',
      type: 'integer',
      min: 1,
      max: 6,
      description: 'Consecutive opposite-direction rounds required (the loss round counts as #1).',
    },
    {
      key: 'confirmationAction',
      label: 'On confirmation',
      type: 'enum',
      options: ['FOLLOW', 'FADE'],
      description: 'Bet with the confirmed new direction, or fade back to the original.',
    },
    {
      key: 'ladderStep1',
      label: 'Attempt 1 (% of bankroll)',
      type: 'number',
      min: 0.01,
      max: 50,
      step: 0.01,
      description: '',
    },
    {
      key: 'ladderStep2',
      label: 'Attempt 2 (% of bankroll)',
      type: 'number',
      min: 0.01,
      max: 50,
      step: 0.01,
      description: '',
    },
    {
      key: 'ladderStep3',
      label: 'Attempt 3 (% of bankroll)',
      type: 'number',
      min: 0.01,
      max: 50,
      step: 0.01,
      description: '',
    },
    {
      key: 'ladderStep4',
      label: 'Attempt 4 (% of bankroll)',
      type: 'number',
      min: 0.01,
      max: 50,
      step: 0.01,
      description: '',
    },
    {
      key: 'maxRecoverySteps',
      label: 'Max recovery steps',
      type: 'integer',
      min: 1,
      max: 4,
      description: 'How many ladder steps are actually used.',
    },
    {
      key: 'sizingMode',
      label: 'Sizing mode',
      type: 'enum',
      options: ['FIXED_PERCENTAGE', 'TARGET_RECOVERY'],
      description:
        'TARGET_RECOVERY sizes to actually recoup losses at the live pool (falls back to the ladder % when no pool reading exists, e.g. in backtests).',
    },
    {
      key: 'targetProfitPercent',
      label: 'Target profit (% of bankroll, TARGET_RECOVERY)',
      type: 'number',
      min: 0,
      max: 50,
      step: 0.1,
      description: '',
    },
    {
      key: 'recoveryCooldownRounds',
      label: 'Cooldown after failure (rounds)',
      type: 'integer',
      min: 0,
      max: 100,
      description: 'No bets for this many rounds after a full ladder failure.',
    },
  ],
  defaults: {
    initialDirection: 'PERSISTENCE',
    requiredPreviousStreak: 1,
    confirmationCount: 1,
    confirmationAction: 'FOLLOW',
    ladderStep1: 1,
    ladderStep2: 3,
    ladderStep3: 6,
    ladderStep4: 10,
    maxRecoverySteps: 4,
    sizingMode: 'FIXED_PERCENTAGE',
    targetProfitPercent: 1,
    recoveryCooldownRounds: 2,
  },
  lookback: (p) => Math.max(100, p.requiredPreviousStreak + p.confirmationCount + 20),
  evaluate(ctx, p) {
    const ladder = [p.ladderStep1, p.ladderStep2, p.ladderStep3, p.ladderStep4];
    const maxSteps = Math.max(1, Math.min(4, Math.floor(p.maxRecoverySteps)));
    const { directions: seq } = seqOf(ctx);
    const ended = seq; // toSequence already dropped ties/cancellations
    const status = recoveryStatus(ctx.ownTrades);

    // `depth`/`priorLossesBnb` are explicit (not read from the closure) so a post-cooldown reset can compute
    // a true step-1 stake and indicator set rather than inheriting the just-abandoned sequence's numbers.
    const stakeFor = (
      direction: Direction,
      depth: number,
      priorLossesBnb: number,
    ): { stakeBnb: number; sizingNote: string } => {
      const ladderPct = ladder[Math.min(depth, 3)]!;
      const fixed = ctx.bankrollBnb * (ladderPct / 100);
      if (p.sizingMode !== 'TARGET_RECOVERY' || depth === 0) {
        return { stakeBnb: fixed, sizingNote: `${ladderPct}% of bankroll (FIXED_PERCENTAGE)` };
      }
      const target = targetRecoveryStakeBnb(ctx, direction, priorLossesBnb, p.targetProfitPercent);
      if (target === null)
        return {
          stakeBnb: fixed,
          sizingNote: `${ladderPct}% of bankroll (TARGET_RECOVERY unavailable: no live pool reading, e.g. backtest)`,
        };
      return {
        stakeBnb: target,
        sizingNote: `sized to recover ${priorLossesBnb.toFixed(6)} BNB in losses + ${p.targetProfitPercent}% target profit at the current pool (TARGET_RECOVERY)`,
      };
    };

    const baseIndicators = (recoveryStep: number, extra: Record<string, unknown>) => ({
      recoveryStep,
      maxRecoverySteps: maxSteps,
      ladder,
      confirmationCount: p.confirmationCount,
      requiredPreviousStreak: p.requiredPreviousStreak,
      confirmationAction: p.confirmationAction,
      previousDirection: status.lastLoss?.direction ?? null,
      priorLossesBnb: status.priorLossesBnb,
      recentSequence: formatSequence(seq),
      ...extra,
    });

    const freshEntry = (rationalePrefix: string, trigger: string, extra: Record<string, unknown>): Signal => {
      const fresh = initialSignal(ctx, p, ended);
      const { stakeBnb, sizingNote } = stakeFor(fresh.direction, 0, 0);
      return {
        action: buyDirection(fresh.direction),
        confidence: fresh.confidence,
        stakeBnb,
        rationale: `${rationalePrefix}: ${fresh.basis}; stake ${sizingNote}`,
        indicators: baseIndicators(1, { trigger, reversalDetected: false, ...extra }),
      };
    };

    // ---- fresh entry: no active recovery sequence -------------------------------------------------------
    if (status.depth === 0) return freshEntry('fresh entry', 'FRESH_ENTRY', {});

    // ---- ladder exhausted: cooldown, then reset ----------------------------------------------------------
    if (status.depth >= maxSteps) {
      const roundsSince = ctx.betting.epoch - status.lastLoss!.epoch;
      if (roundsSince <= p.recoveryCooldownRounds) {
        return skip(
          `recovery sequence failed after ${maxSteps} steps; cooling down (${roundsSince}/${p.recoveryCooldownRounds} rounds)`,
          baseIndicators(maxSteps, {
            trigger: 'RECOVERY_COOLDOWN',
            roundsSinceFailure: roundsSince,
            reversalDetected: false,
          }),
        );
      }
      return freshEntry(`cooldown elapsed (${roundsSince} rounds); fresh entry`, 'SEQUENCE_FAILED_RESET', {
        roundsSinceFailure: roundsSince,
      });
    }

    // ---- mid-ladder: waiting for a confirmed reversal away from the direction we just lost with ----------
    const D = status.lastLoss!.direction;
    const target = opposite(D); // the losing round's own outcome already is target's first occurrence
    const tail = currentStreak(seq);
    if (tail.direction !== target) {
      return skip(
        `waiting for the market to reverse away from ${D} (currently ${tail.direction ?? 'no data'})`,
        baseIndicators(status.depth + 1, { trigger: 'AWAITING_REVERSAL', reversalDetected: false }),
      );
    }
    const trans = lastTransition(seq);
    if (!trans || trans.to !== target || trans.previousRunLength < p.requiredPreviousStreak) {
      return skip(
        `reversal to ${target} seen, but the prior ${D} run (${trans?.previousRunLength ?? 0}) is shorter than required (${p.requiredPreviousStreak})`,
        baseIndicators(status.depth + 1, {
          trigger: 'REVERSAL_TOO_WEAK',
          reversalDetected: true,
          previousRunLength: trans?.previousRunLength ?? 0,
        }),
      );
    }
    if (tail.length < p.confirmationCount) {
      return skip(
        `reversal to ${target} confirming: ${tail.length}/${p.confirmationCount}`,
        baseIndicators(status.depth + 1, {
          trigger: 'CONFIRMATION_PENDING',
          reversalDetected: true,
          confirmationProgress: tail.length,
        }),
      );
    }

    // Confirmed. Historical odds of this exact confirmed-reversal pattern paying off, for display/confidence.
    const est = streakContinuationEstimate(seq, p.confirmationCount);
    const followProb = est?.pContinue ?? null; // P(next continues target, i.e. FOLLOW wins)
    const bet = p.confirmationAction === 'FOLLOW' ? target : D;
    const historicalProbability =
      p.confirmationAction === 'FOLLOW' ? followProb : est ? 1 - est.pContinue! : null;
    const { stakeBnb, sizingNote } = stakeFor(bet, status.depth, status.priorLossesBnb);
    return {
      action: buyDirection(bet),
      confidence: historicalProbability ?? 0.5,
      stakeBnb,
      rationale: `recovery step ${status.depth + 1}/${maxSteps}: confirmed ${target} reversal (${tail.length}/${p.confirmationCount}) after ${trans.previousRunLength}× ${D}; ${p.confirmationAction} → bet ${bet}; stake ${sizingNote}`,
      indicators: baseIndicators(status.depth + 1, {
        trigger: 'REVERSAL_CONFIRMATION',
        reversalDetected: true,
        confirmationProgress: tail.length,
        historicalProbability,
        historicalSampleSize: est?.sampleSize ?? 0,
      }),
    };
  },
};

// ===================================================================================================== ensemble

type EnsembleParams = {
  persistenceWeight: number;
  reversalWeight: number;
  streakWeight: number;
  transitionWeight: number;
  marketEdgeWeight: number;
  threshold: number;
  minSampleSize: number;
};

/** A component's contribution: a score in [-1, +1] (positive favors UP) plus the sample it's based on. */
function componentScore(
  seq: readonly Direction[],
  minSampleSize: number,
): {
  persistence: { score: number; sampleSize: number };
  reversal: { score: number; sampleSize: number };
  streak: { score: number; sampleSize: number };
  transition: { score: number; sampleSize: number };
} {
  const zero = { score: 0, sampleSize: 0 };
  const signed = (pSame: number, direction: Direction) => (pSame - 0.5) * 2 * (direction === 'BULL' ? 1 : -1);

  const p1 = persistenceEstimate(seq, 1);
  const persistenceComp =
    p1 && p1.sampleSize >= minSampleSize
      ? { score: signed(p1.pSame!, p1.direction), sampleSize: p1.sampleSize }
      : zero;

  const tail = currentStreak(seq);
  const trans = lastTransition(seq);
  let reversalComp = zero;
  if (tail.direction && tail.length === 1 && trans && p1 && p1.sampleSize >= minSampleSize) {
    reversalComp = { score: signed(p1.pSame!, p1.direction), sampleSize: p1.sampleSize };
  }

  let streakComp = zero;
  if (tail.direction && tail.length >= 2) {
    const est = streakContinuationEstimate(seq, tail.length);
    if (est && est.sampleSize >= minSampleSize)
      streakComp = { score: signed(est.pContinue!, tail.direction), sampleSize: est.sampleSize };
  }

  let transitionComp = zero;
  if (seq.length >= 2) {
    const context = seq.slice(-2);
    const table = buildNGramTable(seq, 2);
    const est = estimateFor(table, context);
    if (est.sampleSize >= minSampleSize)
      transitionComp = { score: (est.pUp! - 0.5) * 2, sampleSize: est.sampleSize };
  }

  return {
    persistence: persistenceComp,
    reversal: reversalComp,
    streak: streakComp,
    transition: transitionComp,
  };
}

/**
 * Section 18: combines persistence, reversal, streak-continuation, transition-matrix and (live/paper only)
 * market-payout-skew signals with configurable weights into one score. The market-edge component reads the
 * live betting pool and is therefore neutral (0) in backtests, where the pool cannot be observed.
 */
export const ensemble: StrategyPlugin<EnsembleParams> = {
  id: 'ensemble',
  name: 'Ensemble',
  version: '1.0.0',
  description:
    'Combines persistence, reversal, streak, transition-matrix and (live/paper) market-payout-skew signals ' +
    'with configurable weights into one score; bets when |score| clears the threshold. Each component only ' +
    'contributes once its own sample size is large enough — an under-sampled component contributes 0, not a guess.',
  params: [
    {
      key: 'persistenceWeight',
      label: 'Persistence weight',
      type: 'number',
      min: -2,
      max: 2,
      step: 0.1,
      description: '',
    },
    {
      key: 'reversalWeight',
      label: 'Reversal weight',
      type: 'number',
      min: -2,
      max: 2,
      step: 0.1,
      description: '',
    },
    {
      key: 'streakWeight',
      label: 'Streak weight',
      type: 'number',
      min: -2,
      max: 2,
      step: 0.1,
      description: '',
    },
    {
      key: 'transitionWeight',
      label: 'Transition weight',
      type: 'number',
      min: -2,
      max: 2,
      step: 0.1,
      description: '',
    },
    {
      key: 'marketEdgeWeight',
      label: 'Market/payout edge weight',
      type: 'number',
      min: -2,
      max: 2,
      step: 0.1,
      description: 'Live/paper only; 0 in backtests.',
    },
    {
      key: 'threshold',
      label: 'Score threshold',
      type: 'number',
      min: 0,
      max: 5,
      step: 0.05,
      description: 'Minimum |combined score| to bet.',
    },
    {
      key: 'minSampleSize',
      label: 'Min sample size per component',
      type: 'integer',
      min: 5,
      max: 20_000,
      description: '',
    },
  ],
  defaults: {
    persistenceWeight: 1,
    reversalWeight: 1,
    streakWeight: 1,
    transitionWeight: 1,
    marketEdgeWeight: 1,
    threshold: 0.5,
    minSampleSize: 30,
  },
  lookback: () => 500,
  evaluate(ctx, p) {
    const { directions: seq } = seqOf(ctx);
    const comp = componentScore(seq, p.minSampleSize);

    let marketEdgeScore = 0;
    let marketEdgeSample = 0;
    if (ctx.betting.pool && ctx.betting.pool.bullPayout !== null && ctx.betting.pool.bearPayout !== null) {
      const { bullPayout, bearPayout } = ctx.betting.pool;
      const spread = bullPayout - bearPayout;
      const scale = Math.max(bullPayout, bearPayout, 1);
      marketEdgeScore = Math.max(-1, Math.min(1, spread / scale));
      marketEdgeSample = 1;
    }

    const weighted = [
      { name: 'persistence', weight: p.persistenceWeight, ...comp.persistence },
      { name: 'reversal', weight: p.reversalWeight, ...comp.reversal },
      { name: 'streak', weight: p.streakWeight, ...comp.streak },
      { name: 'transition', weight: p.transitionWeight, ...comp.transition },
      {
        name: 'marketEdge',
        weight: p.marketEdgeWeight,
        score: marketEdgeScore,
        sampleSize: marketEdgeSample,
      },
    ];
    const totalScore = weighted.reduce((a, c) => a + c.weight * c.score, 0);
    const weightSum = weighted.reduce((a, c) => a + Math.abs(c.weight), 0) || 1;
    const indicators = {
      components: Object.fromEntries(
        weighted.map((c) => [
          c.name,
          { score: Number(c.score.toFixed(4)), weight: c.weight, sampleSize: c.sampleSize },
        ]),
      ),
      totalScore: Number(totalScore.toFixed(4)),
      threshold: p.threshold,
      recentSequence: formatSequence(seq),
    };
    if (Math.abs(totalScore) < p.threshold) {
      return skip(`combined score ${totalScore.toFixed(3)} below threshold ${p.threshold}`, indicators);
    }
    const bet: Direction = totalScore > 0 ? 'BULL' : 'BEAR';
    const normalized = Math.min(1, Math.abs(totalScore) / weightSum);
    const confidence = 0.5 + normalized * 0.45; // map combined evidence to a bounded (0.5, 0.95] confidence
    return {
      action: buyDirection(bet),
      confidence,
      rationale: `ensemble score ${totalScore.toFixed(3)} (threshold ${p.threshold}) from persistence/reversal/streak/transition/market-edge`,
      indicators,
    };
  },
};

export const SEQUENCE_STRATEGIES: readonly StrategyPlugin[] = [
  persistence as StrategyPlugin,
  reversalStrategy as StrategyPlugin,
  alternationStrategy as StrategyPlugin,
  transitionMatrixStrategy as StrategyPlugin,
  markov as StrategyPlugin,
  sequenceRecovery as StrategyPlugin,
  ensemble as StrategyPlugin,
];
