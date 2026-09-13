/**
 * Pure sequence/pattern analytics over a history of round outcomes: streaks, direction changes, alternation,
 * and n-gram (Markov) transition tables with sample sizes. Used by the sequence-aware strategies in
 * `strategy/sequenceStrategies.ts` and exposed to the dashboard so a pattern's *measured* historical frequency
 * is always visible next to any strategy that claims to exploit it — per the operating principle of this module:
 * a pattern is a hypothesis to test, never an assumption to hard-code.
 *
 * Ties and cancelled rounds carry no direction, so they are dropped when building a sequence: the sequence is
 * the ordered list of *decided* rounds, not raw epoch-adjacent slots. Every probability below is reported with
 * its sample size so a caller can refuse to act on a thin sample (see `MinSample`).
 */
import type { Direction, RoundOutcome, RoundView } from './round.js';

export interface SequenceRound {
  epoch: number;
  direction: Direction;
}

/** Rounds with a direction (BULL/BEAR), oldest → newest; ties and cancellations are dropped and reported. */
export interface DecidedSequence {
  rounds: readonly SequenceRound[];
  directions: readonly Direction[];
  /** Ties/cancellations dropped from the input while building this sequence. */
  skipped: number;
}

export function toSequence(history: readonly RoundView[]): DecidedSequence {
  const rounds: SequenceRound[] = [];
  let skipped = 0;
  for (const r of history) {
    if (r.outcome === 'BULL' || r.outcome === 'BEAR') rounds.push({ epoch: r.epoch, direction: r.outcome });
    else if (r.outcome !== null) skipped++;
  }
  return { rounds, directions: rounds.map((r) => r.direction), skipped };
}

export const opposite = (d: Direction): Direction => (d === 'BULL' ? 'BEAR' : 'BULL');

// -------------------------------------------------------------------------------------------------- streaks

export interface Streak {
  direction: Direction | null;
  /** Length of the run of `direction` ending at the last element (0 if the sequence is empty). */
  length: number;
}

/** The trailing run of identical outcomes at the end of the sequence. */
export function currentStreak(seq: readonly Direction[]): Streak {
  if (seq.length === 0) return { direction: null, length: 0 };
  const direction = seq[seq.length - 1]!;
  let length = 1;
  for (let i = seq.length - 2; i >= 0 && seq[i] === direction; i--) length++;
  return { direction, length };
}

export interface Transition {
  /** Index into `seq` of the first element of the new (post-transition) run. */
  index: number;
  from: Direction;
  to: Direction;
  /** Length of the `from` run that preceded the transition. */
  previousRunLength: number;
}

/** The most recent point where the outcome changed direction, with how long the prior run was. */
export function lastTransition(seq: readonly Direction[]): Transition | null {
  for (let i = seq.length - 1; i > 0; i--) {
    if (seq[i] !== seq[i - 1]) {
      const to = seq[i]!;
      const from = seq[i - 1]!;
      let run = 1;
      for (let j = i - 2; j >= 0 && seq[j] === from; j--) run++;
      return { index: i, from, to, previousRunLength: run };
    }
  }
  return null;
}

/** Length of the trailing strictly-alternating run (A,B,A,B,...) ending at the last element. 0 if empty. */
export function alternationLength(seq: readonly Direction[]): number {
  if (seq.length === 0) return 0;
  let length = 1;
  for (let i = seq.length - 1; i > 0; i--) {
    if (seq[i] === seq[i - 1]) break;
    length++;
  }
  return length;
}

// ------------------------------------------------------------------------------------------------- n-grams

export interface Estimate {
  /** Empirical P(next = BULL | context). Null when sampleSize is 0. */
  pUp: number | null;
  pDown: number | null;
  sampleSize: number;
}

const emptyEstimate: Estimate = { pUp: null, pDown: null, sampleSize: 0 };

/** `["BULL","BEAR"]` → `"BULL,BEAR"`, a stable map key for a context tuple. */
export function contextKey(context: readonly Direction[]): string {
  return context.join(',');
}

/**
 * Builds, for every context of length `order` that occurs in `seq`, the count of times it was followed by
 * BULL vs BEAR. O(n). The table is keyed by `contextKey`; `order = 0` gives the single unconditional context
 * `""` (the base rate).
 */
export function buildNGramTable(
  seq: readonly Direction[],
  order: number,
): Map<string, { up: number; down: number }> {
  const table = new Map<string, { up: number; down: number }>();
  for (let i = order; i < seq.length; i++) {
    const key = contextKey(seq.slice(i - order, i));
    const next = seq[i]!;
    const cell = table.get(key) ?? { up: 0, down: 0 };
    if (next === 'BULL') cell.up++;
    else cell.down++;
    table.set(key, cell);
  }
  return table;
}

/** Reads one context's estimate out of a table built by `buildNGramTable`. */
export function estimateFor(
  table: Map<string, { up: number; down: number }>,
  context: readonly Direction[],
): Estimate {
  const cell = table.get(contextKey(context));
  if (!cell) return emptyEstimate;
  const total = cell.up + cell.down;
  if (total === 0) return emptyEstimate;
  return { pUp: cell.up / total, pDown: cell.down / total, sampleSize: total };
}

/** Convenience: P(next = same as context[last]) and P(next = opposite), for a uniform-context persistence query. */
export function persistenceEstimate(
  seq: readonly Direction[],
  order: number,
): { direction: Direction; pSame: number | null; pOpposite: number | null; sampleSize: number } | null {
  const tail = currentStreak(seq);
  if (tail.direction === null || tail.length < order) return null;
  const context = Array.from({ length: order }, () => tail.direction!);
  const table = buildNGramTable(seq, order);
  const est = estimateFor(table, context);
  const pSame = tail.direction === 'BULL' ? est.pUp : est.pDown;
  const pOpposite = tail.direction === 'BULL' ? est.pDown : est.pUp;
  return { direction: tail.direction, pSame, pOpposite, sampleSize: est.sampleSize };
}

/** 1st-order transition matrix as a display-friendly nested object, e.g. for the dashboard. */
export interface TransitionMatrix1 {
  BULL: { toUp: number | null; toDown: number | null; sampleSize: number };
  BEAR: { toUp: number | null; toDown: number | null; sampleSize: number };
}

export function transitionMatrix1(seq: readonly Direction[]): TransitionMatrix1 {
  const table = buildNGramTable(seq, 1);
  const row = (d: Direction) => {
    const e = estimateFor(table, [d]);
    return { toUp: e.pUp, toDown: e.pDown, sampleSize: e.sampleSize };
  };
  return { BULL: row('BULL'), BEAR: row('BEAR') };
}

/** 2nd-order transition matrix: every (prev2, prev1) context → next-outcome estimate. */
export function transitionMatrix2(
  seq: readonly Direction[],
): Record<string, { toUp: number | null; toDown: number | null; sampleSize: number }> {
  const table = buildNGramTable(seq, 2);
  const out: Record<string, { toUp: number | null; toDown: number | null; sampleSize: number }> = {};
  for (const a of ['BULL', 'BEAR'] as const) {
    for (const b of ['BULL', 'BEAR'] as const) {
      const e = estimateFor(table, [a, b]);
      out[`${a}→${b}`] = { toUp: e.pUp, toDown: e.pDown, sampleSize: e.sampleSize };
    }
  }
  return out;
}

/** P(next continues the streak) vs P(next breaks it), conditioned on the *exact* current streak length. */
export function streakContinuationEstimate(
  seq: readonly Direction[],
  streakLength: number,
): { direction: Direction; pContinue: number | null; pBreak: number | null; sampleSize: number } | null {
  const tail = currentStreak(seq);
  if (tail.direction === null || tail.length !== streakLength) return null;
  const p = persistenceEstimate(seq, streakLength);
  if (!p) return null;
  return { direction: tail.direction, pContinue: p.pSame, pBreak: p.pOpposite, sampleSize: p.sampleSize };
}

/**
 * P(next round continues the alternation) vs P(next round breaks it), conditioned on the trailing alternating
 * run being at least `minLength` — direction-agnostic (alternation is a pattern in the sequence itself, not
 * tied to UP or DOWN), so every historical point whose run already qualified counts as one sample, however
 * long that run eventually grew. O(n).
 */
export function alternationContinuationEstimate(
  seq: readonly Direction[],
  minLength: number,
): {
  expected: Direction;
  pContinue: number | null;
  pBreak: number | null;
  sampleSize: number;
  length: number;
} | null {
  if (seq.length === 0) return null;
  const length = alternationLength(seq);
  if (length < minLength) return null;
  const expected = opposite(seq[seq.length - 1]!); // continuing the alternation flips again

  const altLenAt = new Array<number>(seq.length);
  altLenAt[0] = 1;
  for (let i = 1; i < seq.length; i++) altLenAt[i] = seq[i] !== seq[i - 1] ? altLenAt[i - 1]! + 1 : 1;

  let continued = 0;
  let broken = 0;
  for (let i = minLength; i < seq.length; i++) {
    if (altLenAt[i - 1]! < minLength) continue;
    if (seq[i] !== seq[i - 1]) continued++;
    else broken++;
  }
  const sampleSize = continued + broken;
  const pContinue = sampleSize > 0 ? continued / sampleSize : null;
  return { expected, pContinue, pBreak: pContinue === null ? null : 1 - pContinue, sampleSize, length };
}

/** Human-readable sequence for display/rationale strings, most-recent-last, e.g. "UP,UP,DOWN,DOWN". */
export function formatSequence(seq: readonly Direction[], tail = 8): string {
  return seq
    .slice(-tail)
    .map((d) => (d === 'BULL' ? 'UP' : 'DOWN'))
    .join(',');
}

export function outcomeLabel(o: RoundOutcome | null): string {
  if (o === 'BULL') return 'UP';
  if (o === 'BEAR') return 'DOWN';
  if (o === 'TIE') return 'TIE';
  if (o === 'CANCELLED') return 'CANCELLED';
  return 'PENDING';
}
