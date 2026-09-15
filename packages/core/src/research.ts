/**
 * Research analyses: pure functions over final rounds and, where available, per-bet pool events.
 *
 * Every hypothesis is tested on the chronologically first part of the data (the training split). Every tradable
 * rule derived from it is scored only on the later, held-out rounds, with the treasury fee, own-stake dilution and
 * gas charged. A rule is an edge candidate only if its held-out net return is significantly positive after
 * Benjamini–Hochberg correction across all rules searched, so testing more rules cannot manufacture an edge.
 */
import { estimateBalancePull } from './edge.js';
import type { Direction, RoundOutcome } from './round.js';
import { simulatedPayout } from './round.js';
import {
  Z95,
  benjaminiHochberg,
  meanInterval,
  normalCdf,
  pearson,
  proportionZTest,
  quantile,
  wilsonInterval,
} from './statistics.js';

/** Bump when an analysis changes, so stored experiment results say which code produced them. */
export const RESEARCH_CODE_VERSION = 'research-2';

export interface ResearchRound {
  epoch: number;
  lockTime: number;
  total: bigint;
  bull: bigint;
  bear: bigint;
  reward: bigint;
  rewardBase: bigint;
  outcome: RoundOutcome;
  feeBps: number;
}

/** One bet from the pool event log; `time` is its block timestamp (unix seconds). */
export interface ResearchPoolEvent {
  time: number;
  side: Direction;
  amount: bigint;
}

export interface CostModel {
  stakeWei: bigint;
  gasBetWei: bigint;
  /** Charged once per winning or refunded bet. */
  gasClaimWei: bigint;
}

export interface Hypothesis {
  id: string;
  family: string;
  label: string;
  n: number;
  estimate: number;
  baseline: number;
  pRaw: number;
  pAdj?: number;
}

export interface BetStats {
  bets: number;
  hitRate: number | null;
  hitCi: { low: number; high: number } | null;
  /** Mean net return per unit staked. */
  roi: number | null;
  roiCi: { low: number; high: number } | null;
  /** One-sided p-value that the true mean net return is ≤ 0. */
  roiP: number | null;
  meanWinMultiplier: number | null;
  breakEven: number | null;
  /** The 95% interval of the mean net return lies above zero (before correcting for the rules searched). */
  clears: boolean;
}

export interface TradableRule {
  name: string;
  hypothesisId: string | null;
  stats: BetStats;
  /** BH-adjusted p-value of the hypothesis the rule came from. */
  pAdj: number | null;
  /** BH-adjusted `roiP` across every rule in the study. */
  roiPAdj: number | null;
  edge: boolean;
}

export type StudyFamily = 'baseline' | 'sequence' | 'hour' | 'pool';
export const STUDY_FAMILIES: readonly StudyFamily[] = ['baseline', 'sequence', 'hour', 'pool'];

export interface StudyOptions {
  cost: CostModel;
  /** Chronological share of rounds used to form hypotheses (default 0.7). */
  trainFraction?: number;
  /** Seconds before lock at which pool-based decisions are taken (default 30 and 10). */
  decisionOffsets?: readonly number[];
  families?: readonly StudyFamily[];
  /** False-discovery rate for hypotheses and rules (default 0.05). */
  alpha?: number;
}

const bnb = (wei: bigint) => Number(wei) / 1e18;
const isDecided = (o: RoundOutcome): o is Direction => o === 'BULL' || o === 'BEAR';
const avg = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Deterministic PRNG, so random controls are reproducible. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Break-even hit rate for a stake s and mean winning multiplier M: p* = (s + gasBet) / (s·M − gasClaim). */
export function breakEvenHitRate(cost: CostModel, multiplier: number): number {
  const s = bnb(cost.stakeWei);
  return (s + bnb(cost.gasBetWei)) / (s * multiplier - bnb(cost.gasClaimWei));
}

/** Realised result of betting `side` with the cost model's stake: own stake added to the pool, all gas charged. */
export function summarizeBets(
  bets: readonly { r: ResearchRound; side: Direction }[],
  cost: CostModel,
): BetStats {
  const stake = bnb(cost.stakeWei);
  const returns: number[] = [];
  const winMultipliers: number[] = [];
  let resolved = 0;
  let wins = 0;
  for (const { r, side } of bets) {
    const payout = simulatedPayout(
      { bullAmount: r.bull, bearAmount: r.bear },
      r.outcome,
      side,
      cost.stakeWei,
      r.feeBps,
    );
    const net = payout - cost.stakeWei - cost.gasBetWei - (payout > 0n ? cost.gasClaimWei : 0n);
    returns.push(bnb(net) / stake);
    if (r.outcome === 'CANCELLED') continue;
    resolved++;
    if (payout > 0n) {
      wins++;
      winMultipliers.push(bnb(payout) / stake);
    }
  }
  const roi = meanInterval(returns);
  const m = avg(winMultipliers);
  const roiP = roi ? (roi.se > 0 ? normalCdf(-roi.mean / roi.se) : roi.mean > 0 ? 0 : 1) : null;
  return {
    bets: bets.length,
    hitRate: resolved ? wins / resolved : null,
    hitCi: wilsonInterval(wins, resolved),
    roi: roi?.mean ?? null,
    roiCi: roi ? { low: roi.low, high: roi.high } : null,
    roiP,
    meanWinMultiplier: m,
    breakEven: m ? breakEvenHitRate(cost, m) : null,
    clears: roi !== null && roi.low > 0,
  };
}

/** Pool from bets in blocks timestamped strictly before `cutoff` (a same-second block may postdate the decision). */
export function poolBefore(
  events: readonly ResearchPoolEvent[],
  cutoff: number,
): { bull: bigint; bear: bigint; bets: number } {
  let bull = 0n;
  let bear = 0n;
  let bets = 0;
  for (const e of events) {
    if (e.time >= cutoff) continue;
    bets++;
    if (e.side === 'BULL') bull += e.amount;
    else bear += e.amount;
  }
  return { bull, bear, bets };
}

export function outcomeDistribution(rounds: readonly ResearchRound[]) {
  const counts: Record<RoundOutcome, number> = { BULL: 0, BEAR: 0, TIE: 0, CANCELLED: 0 };
  for (const r of rounds) counts[r.outcome]++;
  const n = rounds.length;
  const decided = counts.BULL + counts.BEAR;
  return {
    n,
    rows: (Object.keys(counts) as RoundOutcome[]).map((k) => ({
      outcome: k,
      count: counts[k],
      share: n ? counts[k] / n : null,
      ci: wilsonInterval(counts[k], n),
    })),
    decided,
    bullGivenDecided: decided ? counts.BULL / decided : null,
    bullGivenDecidedCi: wilsonInterval(counts.BULL, decided),
    bullTest: proportionZTest(counts.BULL, decided, 0.5),
  };
}

/** Payout multipliers and the house's share of every pool (fee, ties and unbacked winning sides). */
export function payoutStats(rounds: readonly ResearchRound[]) {
  const mBull: number[] = [];
  const mBear: number[] = [];
  const winner: number[] = [];
  const perRoundTake: number[] = [];
  let emptySide = 0;
  let emptyWinner = 0;
  let houseTake = 0n;
  let totalPool = 0n;
  for (const r of rounds) {
    totalPool += r.total;
    const f = 1 - r.feeBps / 10_000;
    let take = 0n;
    if (r.outcome === 'TIE') take = r.total;
    else if (isDecided(r.outcome)) {
      take = r.total - r.reward;
      if (r.rewardBase === 0n) {
        take = r.total; // nobody backed the winning side: the whole pot is unclaimable
        emptyWinner++;
      } else winner.push(bnb(r.reward) / bnb(r.rewardBase));
    }
    houseTake += take;
    if (r.total > 0n) perRoundTake.push(bnb(take) / bnb(r.total));
    if (r.bull === 0n || r.bear === 0n) {
      emptySide++;
      continue;
    }
    if (r.outcome === 'CANCELLED') continue;
    mBull.push((bnb(r.total) * f) / bnb(r.bull));
    mBear.push((bnb(r.total) * f) / bnb(r.bear));
  }
  const dist = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return {
      n: s.length,
      mean: avg(s),
      p5: quantile(s, 0.05),
      p25: quantile(s, 0.25),
      p50: quantile(s, 0.5),
      p75: quantile(s, 0.75),
      p95: quantile(s, 0.95),
    };
  };
  return {
    bull: dist(mBull),
    bear: dist(mBear),
    winner: dist(winner),
    emptySide,
    emptyWinner,
    poolWeightedTake: totalPool > 0n ? bnb(houseTake) / bnb(totalPool) : null,
    meanRoundTake: avg(perRoundTake),
    totalPoolBnb: bnb(totalPool),
    houseTakeBnb: bnb(houseTake),
  };
}

/** Rules with no information: they measure the cost of playing. */
export function controls(rounds: readonly ResearchRound[], cost: CostModel, seed = 20260914) {
  const rand = lcg(seed);
  return {
    alwaysBull: summarizeBets(
      rounds.map((r) => ({ r, side: 'BULL' as Direction })),
      cost,
    ),
    alwaysBear: summarizeBets(
      rounds.map((r) => ({ r, side: 'BEAR' as Direction })),
      cost,
    ),
    random: summarizeBets(
      rounds.map((r) => ({ r, side: (rand() < 0.5 ? 'BULL' : 'BEAR') as Direction })),
      cost,
    ),
  };
}

interface Draft {
  hypotheses: Hypothesis[];
  rules: { name: string; hypothesisId: string | null; stats: BetStats }[];
}

/**
 * Conditional outcome probabilities given the last k decided outcomes. Lag 1 is the classic transition matrix: it
 * uses round n−1, which is still running while round n takes bets, so it is NOT tradable. Lag 2 uses only rounds
 * ≤ n−2, which is what a bettor actually knows. Ties and cancellations are skipped in the sequence.
 */
export function sequenceStudy(rounds: readonly ResearchRound[], cost: CostModel, trainFraction: number) {
  const split = Math.floor(rounds.length * trainFraction);
  const trainDecided = rounds.slice(0, split).filter((r) => isDecided(r.outcome));
  if (trainDecided.length === 0) return null;
  const p0 = trainDecided.filter((r) => r.outcome === 'BULL').length / trainDecided.length;
  const acc = new Map<
    string,
    {
      lag: number;
      context: string;
      trainN: number;
      trainBull: number;
      testN: number;
      testBull: number;
      testRounds: ResearchRound[];
    }
  >();
  for (const lag of [1, 2]) {
    const hist: string[] = [];
    let p = 0;
    for (let j = 0; j < rounds.length; j++) {
      const r = rounds[j]!;
      while (p < j && rounds[p]!.epoch <= r.epoch - lag) {
        const o = rounds[p]!.outcome;
        if (isDecided(o)) hist.push(o === 'BULL' ? 'U' : 'D');
        p++;
      }
      for (let k = 1; k <= 4 && k <= hist.length; k++) {
        const context = hist.slice(-k).join('');
        const key = `${lag}:${context}`;
        let s = acc.get(key);
        if (!s)
          acc.set(
            key,
            (s = { lag, context, trainN: 0, trainBull: 0, testN: 0, testBull: 0, testRounds: [] }),
          );
        const bull = r.outcome === 'BULL' ? 1 : 0;
        if (j < split) {
          if (isDecided(r.outcome)) {
            s.trainN++;
            s.trainBull += bull;
          }
        } else {
          if (isDecided(r.outcome)) {
            s.testN++;
            s.testBull += bull;
          }
          if (lag === 2) s.testRounds.push(r);
        }
      }
    }
  }
  const draft: Draft = { hypotheses: [], rules: [] };
  const contexts = [...acc.values()]
    .sort(
      (a, b) => a.lag - b.lag || a.context.length - b.context.length || a.context.localeCompare(b.context),
    )
    .map((s) => {
      const id = `seq-lag${s.lag}-${s.context}`;
      const t = proportionZTest(s.trainBull, s.trainN, p0);
      if (t)
        draft.hypotheses.push({
          id,
          family: s.lag === 1 ? 'sequence (lag 1, statistical)' : 'sequence (lag 2, tradable)',
          label: `P(BULL | last ${s.context.length} = ${s.context})`,
          n: s.trainN,
          estimate: s.trainBull / s.trainN,
          baseline: p0,
          pRaw: t.pValue,
        });
      const predicted: Direction | null =
        s.trainN === 0 ? null : s.trainBull / s.trainN > 0.5 ? 'BULL' : 'BEAR';
      const test =
        s.lag === 2 && predicted
          ? summarizeBets(
              s.testRounds.map((r) => ({ r, side: predicted })),
              cost,
            )
          : null;
      if (test && t)
        draft.rules.push({ name: `sequence ${s.context} → ${predicted}`, hypothesisId: id, stats: test });
      return {
        lag: s.lag,
        context: s.context,
        trainN: s.trainN,
        trainBull: s.trainBull,
        testN: s.testN,
        testBull: s.testBull,
        predicted,
        hypothesisId: id,
        test,
      };
    });
  return { p0Train: p0, split, contexts, ...draft };
}

/** Outcome probability by UTC hour of the lock time. */
export function hourStudy(rounds: readonly ResearchRound[], cost: CostModel, trainFraction: number) {
  const split = Math.floor(rounds.length * trainFraction);
  const hours = Array.from({ length: 24 }, () => ({ trainN: 0, trainBull: 0, test: [] as ResearchRound[] }));
  let decided = 0;
  let bulls = 0;
  rounds.forEach((r, j) => {
    const h = hours[new Date(r.lockTime * 1000).getUTCHours()]!;
    if (j >= split) {
      h.test.push(r);
      return;
    }
    if (!isDecided(r.outcome)) return;
    h.trainN++;
    decided++;
    if (r.outcome === 'BULL') {
      h.trainBull++;
      bulls++;
    }
  });
  if (decided === 0) return null;
  const p0 = bulls / decided;
  const draft: Draft = { hypotheses: [], rules: [] };
  const rows = hours.map((h, hour) => {
    const id = `hour-${hour}`;
    const t = proportionZTest(h.trainBull, h.trainN, p0);
    if (t)
      draft.hypotheses.push({
        id,
        family: 'time of day (UTC)',
        label: `P(BULL | hour ${hour})`,
        n: h.trainN,
        estimate: h.trainBull / h.trainN,
        baseline: p0,
        pRaw: t.pValue,
      });
    const predicted: Direction | null =
      h.trainN === 0 ? null : h.trainBull / h.trainN > 0.5 ? 'BULL' : 'BEAR';
    const test = predicted
      ? summarizeBets(
          h.test.map((r) => ({ r, side: predicted })),
          cost,
        )
      : null;
    if (test && t) draft.rules.push({ name: `hour ${hour} → ${predicted}`, hypothesisId: id, stats: test });
    return { hour, trainN: h.trainN, pBull: h.trainN ? h.trainBull / h.trainN : null, predicted, test };
  });
  return { p0Train: p0, split, hours: rows, ...draft };
}

/**
 * What the pool looked like `offset` seconds before lock, and whether it predicts the outcome. Only rounds whose
 * events sum exactly to the final pools are used (anything else means pruned or missing logs).
 */
export function poolStudy(
  rounds: readonly ResearchRound[],
  events: ReadonlyMap<number, readonly ResearchPoolEvent[]>,
  cost: CostModel,
  offsets: readonly number[],
  trainFraction: number,
) {
  const sample: { r: ResearchRound; at: { bull: bigint; bear: bigint }[] }[] = [];
  let candidates = 0;
  for (const r of rounds) {
    const evs = events.get(r.epoch);
    if (!evs) continue;
    candidates++;
    const all = poolBefore(evs, Number.POSITIVE_INFINITY);
    if (all.bull !== r.bull || all.bear !== r.bear) continue;
    sample.push({ r, at: offsets.map((off) => poolBefore(evs, r.lockTime - off)) });
  }
  if (sample.length === 0) return null;
  const decided = sample.filter((s) => isDecided(s.r.outcome));
  const p0 = decided.length ? decided.filter((s) => s.r.outcome === 'BULL').length / decided.length : 0.5;
  const split = Math.floor(sample.length * trainFraction);
  const draft: Draft = { hypotheses: [], rules: [] };

  const perOffset = offsets.map((off, oi) => {
    const lateShares: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const longOos: { r: ResearchRound; side: Direction }[] = [];
    const favOos: { r: ResearchRound; side: Direction }[] = [];
    const shares: { decisionShare: number; finalShare: number }[] = [];
    sample.forEach(({ r, at }, idx) => {
      const a = at[oi]!;
      const seen = a.bull + a.bear;
      if (r.total > 0n) lateShares.push(bnb(r.total - seen) / bnb(r.total));
      if (seen === 0n) return;
      if (r.total > 0n)
        shares.push({ decisionShare: bnb(a.bull) / bnb(seen), finalShare: bnb(r.bull) / bnb(r.total) });
      if (idx < split) {
        if (isDecided(r.outcome)) {
          xs.push(bnb(a.bull) / bnb(seen));
          ys.push(r.outcome === 'BULL' ? 1 : 0);
        }
        return;
      }
      const long: Direction = a.bull <= a.bear ? 'BULL' : 'BEAR';
      longOos.push({ r, side: long });
      favOos.push({ r, side: long === 'BULL' ? 'BEAR' : 'BULL' });
    });
    const corr = pearson(xs, ys);
    if (corr)
      draft.hypotheses.push({
        id: `pool-corr-T${off}`,
        family: 'decision-time pool imbalance',
        label: `corr(bull share at T−${off}s, BULL)`,
        n: corr.n,
        estimate: corr.r,
        baseline: 0,
        pRaw: corr.pValue,
      });
    const sortedX = [...xs].sort((a, b) => a - b);
    const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(sortedX, q) ?? 0);
    const buckets = Array.from({ length: 5 }, () => ({ n: 0, bull: 0 }));
    xs.forEach((x, i) => {
      const b = buckets[cuts.filter((c) => x > c).length]!;
      b.n++;
      b.bull += ys[i]!;
    });
    const quintiles = buckets.map((b, qi) => {
      const t = proportionZTest(b.bull, b.n, p0);
      if (t)
        draft.hypotheses.push({
          id: `pool-q${qi + 1}-T${off}`,
          family: 'decision-time pool imbalance',
          label: `P(BULL | bull-share quintile ${qi + 1} at T−${off}s)`,
          n: b.n,
          estimate: b.bull / b.n,
          baseline: p0,
          pRaw: t.pValue,
        });
      return { quintile: qi + 1, n: b.n, pBull: b.n ? b.bull / b.n : null, ci: wilsonInterval(b.bull, b.n) };
    });
    const longOdds = summarizeBets(longOos, cost);
    const favourite = summarizeBets(favOos, cost);
    draft.rules.push(
      { name: `long-odds side at T−${off}s`, hypothesisId: null, stats: longOdds },
      { name: `favourite side at T−${off}s`, hypothesisId: null, stats: favourite },
    );
    const late = [...lateShares].sort((a, b) => a - b);
    return {
      offset: off,
      lateFlow: { n: late.length, mean: avg(late), median: quantile(late, 0.5) },
      /** Calibration for the edge engine's EDGE_BALANCE_PULL at this decision offset. */
      balancePull: estimateBalancePull(shares),
      correlation: corr,
      quintiles,
      longOdds,
      favourite,
    };
  });
  return {
    candidates,
    sampleRounds: sample.length,
    fromEpoch: sample[0]!.r.epoch,
    toEpoch: sample.at(-1)!.r.epoch,
    p0,
    perOffset,
    ...draft,
  };
}

export interface StudyResult {
  rounds: number;
  fromEpoch: number | null;
  toEpoch: number | null;
  trainFraction: number;
  alpha: number;
  outcomes: ReturnType<typeof outcomeDistribution>;
  payouts: ReturnType<typeof payoutStats>;
  controls: ReturnType<typeof controls>;
  sequence: Omit<NonNullable<ReturnType<typeof sequenceStudy>>, keyof Draft> | null;
  hours: Omit<NonNullable<ReturnType<typeof hourStudy>>, keyof Draft> | null;
  pools: Omit<NonNullable<ReturnType<typeof poolStudy>>, keyof Draft> | null;
  hypotheses: Hypothesis[];
  survivors: Hypothesis[];
  rules: TradableRule[];
  edges: TradableRule[];
  /** Hit rate a direction-agnostic bettor needs to break even (from the random control). */
  breakEvenHitRate: number | null;
  verdict: 'NO_EDGE' | 'EDGE_CANDIDATE';
}

/** Runs the selected families over chronologically ordered final rounds and corrects for everything tested. */
export function runStudy(
  rounds: readonly ResearchRound[],
  options: StudyOptions,
  events?: ReadonlyMap<number, readonly ResearchPoolEvent[]>,
): StudyResult {
  const families = new Set(options.families ?? STUDY_FAMILIES);
  const trainFraction = options.trainFraction ?? 0.7;
  const offsets = options.decisionOffsets ?? [30, 10];
  const alpha = options.alpha ?? 0.05;
  const hypotheses: Hypothesis[] = [];
  const drafts: Draft['rules'] = [];
  const take = <T extends Draft>(d: T | null): Omit<T, keyof Draft> | null => {
    if (!d) return null;
    const { hypotheses: h, rules: r, ...rest } = d;
    hypotheses.push(...h);
    drafts.push(...r);
    return rest;
  };

  const outcomes = outcomeDistribution(rounds);
  if (families.has('baseline') && outcomes.bullTest)
    hypotheses.push({
      id: 'bull-bias',
      family: 'baseline',
      label: 'P(BULL | decided) ≠ 0.5',
      n: outcomes.decided,
      estimate: outcomes.bullGivenDecided!,
      baseline: 0.5,
      pRaw: outcomes.bullTest.pValue,
    });
  const sequence = families.has('sequence') ? take(sequenceStudy(rounds, options.cost, trainFraction)) : null;
  const hours = families.has('hour') ? take(hourStudy(rounds, options.cost, trainFraction)) : null;
  const pools =
    families.has('pool') && events
      ? take(poolStudy(rounds, events, options.cost, offsets, trainFraction))
      : null;

  const adjusted = benjaminiHochberg(hypotheses.map((h) => h.pRaw));
  hypotheses.forEach((h, i) => (h.pAdj = adjusted[i]));
  const adjOf = new Map(hypotheses.map((h) => [h.id, h.pAdj!]));
  const scored = drafts.filter((r) => r.stats.roiP !== null);
  const roiAdj = benjaminiHochberg(scored.map((r) => r.stats.roiP!));
  const roiAdjOf = new Map(scored.map((r, i) => [r, roiAdj[i]!]));
  const rules: TradableRule[] = drafts.map((r) => {
    const roiPAdj = roiAdjOf.get(r) ?? null;
    return {
      ...r,
      pAdj: r.hypothesisId ? (adjOf.get(r.hypothesisId) ?? null) : null,
      roiPAdj,
      edge: r.stats.clears && roiPAdj !== null && roiPAdj < alpha,
    };
  });
  const edges = rules.filter((r) => r.edge);
  const ctl = controls(rounds, options.cost);
  return {
    rounds: rounds.length,
    fromEpoch: rounds[0]?.epoch ?? null,
    toEpoch: rounds.at(-1)?.epoch ?? null,
    trainFraction,
    alpha,
    outcomes,
    payouts: payoutStats(rounds),
    controls: ctl,
    sequence,
    hours,
    pools,
    hypotheses,
    survivors: hypotheses.filter((h) => h.pAdj! < alpha),
    rules,
    edges,
    breakEvenHitRate: ctl.random.breakEven,
    verdict: edges.length > 0 ? 'EDGE_CANDIDATE' : 'NO_EDGE',
  };
}

/** Standard error implied by a 95% interval (for display next to stored results). */
export const seFromCi = (ci: { low: number; high: number }) => (ci.high - ci.low) / (2 * Z95);
