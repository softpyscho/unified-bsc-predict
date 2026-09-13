/**
 * Round model and the PancakeSwap Prediction V2 settlement rules.
 *
 * Contract behaviour reproduced here (PancakePredictionV2.sol):
 *  - executeRound() locks `currentEpoch`, ends `currentEpoch - 1` and starts `currentEpoch + 1` in one tx,
 *    so a round's start price equals the previous round's lock price.
 *  - _safeEndRound requires block.timestamp <= closeTimestamp + bufferSeconds. A round that is not ended by
 *    then can never be ended: bets are refundable (refundable() == true) and the round is final as CANCELLED.
 *  - _calculateRewards: winner side gets rewardAmount = total - total * treasuryFee / 10000, split pro rata by
 *    rewardBaseCalAmount (winning side total). On a tie rewardBaseCalAmount = rewardAmount = 0: the house takes
 *    the whole pool and no bet is claimable.
 *  - claim(): reward = betAmount * rewardAmount / rewardBaseCalAmount (integer division).
 */
import { BPS_DENOMINATOR, priceToUsd, ratio, weiToBnb } from './units.js';

export type Direction = 'BULL' | 'BEAR';
export type RoundOutcome = 'BULL' | 'BEAR' | 'TIE' | 'CANCELLED';
export type RoundStatus =
  | 'UPCOMING' // not yet started
  | 'OPEN' // accepting bets (start <= now < lock)
  | 'LOCKING' // lock time passed, lock tx not yet mined
  | 'LIVE' // locked, waiting for close
  | 'CLOSING' // close time passed, end tx not yet mined
  | 'ENDED' // final: oracle called, outcome known
  | 'CANCELLED'; // final: not ended within buffer, bets refundable

export const FINAL_STATUSES: ReadonlySet<RoundStatus> = new Set(['ENDED', 'CANCELLED']);

/** Exact on-chain round data. Prices are 8-decimal integers (exact in a JS number), amounts are wei. */
export interface RoundRecord {
  epoch: number;
  startTime: number | null;
  lockTime: number | null;
  closeTime: number | null;
  lockPrice: number | null;
  closePrice: number | null;
  lockOracleId: string | null;
  closeOracleId: string | null;
  totalAmount: bigint;
  bullAmount: bigint;
  bearAmount: bigint;
  rewardBaseCalAmount: bigint;
  rewardAmount: bigint;
  oracleCalled: boolean;
}

/** A round whose outcome can never change again. */
export interface FinalRound extends RoundRecord {
  outcome: RoundOutcome;
}

export function isLocked(r: Pick<RoundRecord, 'lockPrice' | 'lockOracleId'>): boolean {
  return (r.lockOracleId !== null && r.lockOracleId !== '0') || (r.lockPrice !== null && r.lockPrice !== 0);
}

/**
 * Derives round status from chain state. `chainTime` must be a block timestamp (not the local clock)
 * whenever the result is used to decide finality.
 */
export function deriveRoundStatus(r: RoundRecord, chainTime: number, bufferSeconds: number): RoundStatus {
  if (r.oracleCalled) return 'ENDED';
  if (r.closeTime !== null && r.closeTime > 0 && chainTime > r.closeTime + bufferSeconds) return 'CANCELLED';
  if (isLocked(r)) return r.closeTime !== null && chainTime < r.closeTime ? 'LIVE' : 'CLOSING';
  if (r.startTime !== null && chainTime < r.startTime) return 'UPCOMING';
  if (r.lockTime !== null && chainTime < r.lockTime) return 'OPEN';
  return 'LOCKING';
}

/** Outcome of a round in a final status; null while the round can still change. */
export function deriveOutcome(r: RoundRecord, status: RoundStatus): RoundOutcome | null {
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status !== 'ENDED') return null;
  const lock = r.lockPrice ?? 0;
  const close = r.closePrice ?? 0;
  if (close > lock) return 'BULL';
  if (close < lock) return 'BEAR';
  return 'TIE';
}

/** Exact amount the contract pays back on claim for a bet that is already part of the pool. */
export function settledPayout(
  round: Pick<RoundRecord, 'rewardAmount' | 'rewardBaseCalAmount'>,
  outcome: RoundOutcome,
  direction: Direction,
  amount: bigint,
): bigint {
  if (outcome === 'CANCELLED') return amount;
  if (outcome === 'TIE' || outcome !== direction) return 0n;
  if (round.rewardBaseCalAmount === 0n) return 0n;
  return (amount * round.rewardAmount) / round.rewardBaseCalAmount;
}

/**
 * Payout for a hypothetical stake that is NOT in the recorded pool (paper trading, backtests).
 * The stake is added to the pool so its own dilution of the payout is modelled exactly.
 */
export function simulatedPayout(
  pool: Pick<RoundRecord, 'bullAmount' | 'bearAmount'>,
  outcome: RoundOutcome,
  direction: Direction,
  stake: bigint,
  treasuryFeeBps: number,
): bigint {
  if (outcome === 'CANCELLED') return stake;
  if (outcome === 'TIE' || outcome !== direction) return 0n;
  const total = pool.bullAmount + pool.bearAmount + stake;
  const treasury = (total * BigInt(treasuryFeeBps)) / BPS_DENOMINATOR;
  const reward = total - treasury;
  const base = (direction === 'BULL' ? pool.bullAmount : pool.bearAmount) + stake;
  return (stake * reward) / base;
}

/** Gross payout multiplier for one side given the current pool (includes the stake returned). */
export function payoutMultiplier(
  pool: Pick<RoundRecord, 'bullAmount' | 'bearAmount'>,
  side: Direction,
  treasuryFeeBps: number,
): number | null {
  const total = pool.bullAmount + pool.bearAmount;
  const sideAmount = side === 'BULL' ? pool.bullAmount : pool.bearAmount;
  const reward = total - (total * BigInt(treasuryFeeBps)) / BPS_DENOMINATOR;
  return ratio(reward, sideAmount);
}

/** Float view of a round, used as strategy input and for display. Never used for accounting. */
export interface RoundView {
  epoch: number;
  startTime: number | null;
  lockTime: number | null;
  closeTime: number | null;
  lockPrice: number | null;
  closePrice: number | null;
  outcome: RoundOutcome | null;
  bullAmount: number;
  bearAmount: number;
  totalAmount: number;
  bullPayout: number | null;
  bearPayout: number | null;
}

export function toRoundView(r: RoundRecord, outcome: RoundOutcome | null, treasuryFeeBps: number): RoundView {
  return {
    epoch: r.epoch,
    startTime: r.startTime,
    lockTime: r.lockTime,
    closeTime: r.closeTime,
    lockPrice: priceToUsd(r.lockPrice),
    closePrice: priceToUsd(r.closePrice),
    outcome,
    bullAmount: weiToBnb(r.bullAmount),
    bearAmount: weiToBnb(r.bearAmount),
    totalAmount: weiToBnb(r.bullAmount + r.bearAmount),
    bullPayout: payoutMultiplier(r, 'BULL', treasuryFeeBps),
    bearPayout: payoutMultiplier(r, 'BEAR', treasuryFeeBps),
  };
}

/** Converts a raw `rounds(epoch)` tuple (PancakeSwap V2) into a RoundRecord. */
export function roundFromV2Tuple(t: {
  epoch: bigint;
  startTimestamp: bigint;
  lockTimestamp: bigint;
  closeTimestamp: bigint;
  lockPrice: bigint;
  closePrice: bigint;
  lockOracleId: bigint;
  closeOracleId: bigint;
  totalAmount: bigint;
  bullAmount: bigint;
  bearAmount: bigint;
  rewardBaseCalAmount: bigint;
  rewardAmount: bigint;
  oracleCalled: boolean;
}): RoundRecord {
  const time = (v: bigint) => (v === 0n ? null : Number(v));
  const price = (v: bigint) => (v === 0n ? null : Number(v));
  return {
    epoch: Number(t.epoch),
    startTime: time(t.startTimestamp),
    lockTime: time(t.lockTimestamp),
    closeTime: time(t.closeTimestamp),
    lockPrice: price(t.lockPrice),
    closePrice: price(t.closePrice),
    lockOracleId: t.lockOracleId === 0n ? null : t.lockOracleId.toString(),
    closeOracleId: t.closeOracleId === 0n ? null : t.closeOracleId.toString(),
    totalAmount: t.totalAmount,
    bullAmount: t.bullAmount,
    bearAmount: t.bearAmount,
    rewardBaseCalAmount: t.rewardBaseCalAmount,
    rewardAmount: t.rewardAmount,
    oracleCalled: t.oracleCalled,
  };
}
