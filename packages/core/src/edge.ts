/**
 * Edge engine: the expected value of a bet at decision time, net of everything between a displayed multiplier and
 * money received — the treasury fee, the bettor's own stake diluting the payout, gas for the bet and for the claim,
 * and the money that arrives after the decision.
 *
 * Late money is modelled as a pull toward balance, which is what the Phase 0 pool data shows: most of the pool
 * arrives in the last 30 s and flows into the side that looks cheap, so long odds seen at decision time mostly
 * evaporate by lock. The chosen side's share of the pool is expected to end at
 *   share + balancePull × (0.5 − share)
 * (0 = pools stay as they are, 1 = they always finish balanced). The research `pool` family estimates it.
 * Ties are treated as losses and cancellations are ignored; both are rare.
 */
import type { Direction } from './round.js';

export interface EdgeModel {
  gasBetBnb: number;
  /** Paid only when the bet wins. */
  gasClaimBnb: number;
  /** 0..1: how far the pool's split is expected to move toward 50/50 by lock. */
  balancePull: number;
}

export const NO_COSTS: EdgeModel = { gasBetBnb: 0, gasClaimBnb: 0, balancePull: 0 };

export interface EdgeInput {
  /** Probability that the chosen side wins. */
  probability: number;
  direction: Direction;
  /** Pool at decision time, in BNB, not including this bet. */
  pool: { bullAmount: number; bearAmount: number };
  stakeBnb: number;
  treasuryFeeBps: number;
  model: EdgeModel;
}

export interface EdgeBreakdown {
  probability: number;
  /** Multiplier as displayed (pool without this bet); null when the side is empty. */
  displayedMultiplier: number | null;
  /** Multiplier once this stake is in the pool as it stands. */
  dilutedMultiplier: number;
  /** After late money pulls the split toward balance: what the bet is expected to pay if it wins. */
  expectedMultiplier: number;
  /** Win probability at which the bet breaks even after costs (may exceed 1: unwinnable). */
  breakEvenProbability: number | null;
  /** Expected net profit per unit staked. */
  ev: number;
  evBnb: number;
}

export function expectedValue(i: EdgeInput): EdgeBreakdown | null {
  const s = i.stakeBnb;
  if (!(s > 0) || !Number.isFinite(i.probability)) return null;
  const { bullAmount, bearAmount } = i.pool;
  const side = i.direction === 'BULL' ? bullAmount : bearAmount;
  const total = bullAmount + bearAmount;
  const f = 1 - i.treasuryFeeBps / 10_000;
  const pull = Math.min(1, Math.max(0, i.model.balancePull));
  const displayed = side > 0 ? (total * f) / side : null;
  const diluted = ((total + s) * f) / (side + s);
  // The pool total is kept at its decision-time size: late money would also dilute this stake less, so ignoring
  // its growth errs on the side of a lower estimate.
  const share = total > 0 ? side / total : 0.5;
  const finalSide = total > 0 ? (share + pull * (0.5 - share)) * total : 0;
  const expected = ((total + s) * f) / (finalSide + s);
  const { gasBetBnb: gB, gasClaimBnb: gC } = i.model;
  const evBnb = i.probability * (s * expected - s - gB - gC) + (1 - i.probability) * (-s - gB);
  const denom = s * expected - gC;
  return {
    probability: i.probability,
    displayedMultiplier: displayed,
    dilutedMultiplier: diluted,
    expectedMultiplier: expected,
    breakEvenProbability: denom > 0 ? (s + gB) / denom : null,
    ev: evBnb / s,
    evBnb,
  };
}

/**
 * Least-squares estimate of `balancePull` from observed rounds: regress the final bull share on the decision-time
 * bull share, both centred on 0.5, through the origin; the pull is 1 − slope. Null with fewer than 10 rounds.
 */
export function estimateBalancePull(
  pairs: readonly { decisionShare: number; finalShare: number }[],
): { pull: number; n: number } | null {
  let sxy = 0;
  let sxx = 0;
  let n = 0;
  for (const p of pairs) {
    if (!Number.isFinite(p.decisionShare) || !Number.isFinite(p.finalShare)) continue;
    const x = p.decisionShare - 0.5;
    sxy += x * (p.finalShare - 0.5);
    sxx += x * x;
    n++;
  }
  if (n < 10 || sxx === 0) return null;
  return { pull: 1 - sxy / sxx, n };
}
