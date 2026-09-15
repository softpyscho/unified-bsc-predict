import type { FinalRound, RiskLimits, RoundOutcome } from '../src/index.js';
import { bnbToWei } from '../src/index.js';

export const T0 = 1_700_000_000;
export const INTERVAL = 300;
export const BUFFER = 30;

/**
 * Consecutive PancakeSwap-style rounds: round i starts when round i-1 locks, so
 * lock_i = start_i + 300, close_i = lock_i + 300 = lock_{i+1}; lock price of i = close price of i-1.
 */
export function series(
  outcomes: readonly RoundOutcome[],
  opts: { firstEpoch?: number; pool?: bigint } = {},
): FinalRound[] {
  const pool = opts.pool ?? bnbToWei(1);
  const first = opts.firstEpoch ?? 100;
  let price = 60_000_000_000; // $600.00000000
  return outcomes.map((outcome, i) => {
    const start = T0 + i * INTERVAL;
    const lockPrice = price;
    const closePrice =
      outcome === 'BULL'
        ? price + 10_000_000
        : outcome === 'BEAR'
          ? price - 10_000_000
          : outcome === 'TIE'
            ? price
            : null;
    if (closePrice !== null) price = closePrice;
    const total = pool * 2n;
    const cancelled = outcome === 'CANCELLED';
    const reward = cancelled || outcome === 'TIE' ? 0n : total - (total * 300n) / 10_000n;
    return {
      epoch: first + i,
      startTime: start,
      lockTime: start + INTERVAL,
      closeTime: start + 2 * INTERVAL,
      lockPrice,
      closePrice,
      lockOracleId: '1',
      closeOracleId: cancelled ? null : '2',
      totalAmount: total,
      bullAmount: pool,
      bearAmount: pool,
      rewardBaseCalAmount: cancelled || outcome === 'TIE' ? 0n : pool,
      rewardAmount: reward,
      oracleCalled: !cancelled,
      outcome,
    };
  });
}

export const LOOSE_LIMITS: RiskLimits = {
  maxStakeWei: bnbToWei(100),
  minStakeWei: 0n,
  escalationStakeWei: 0n,
  escalationMinLossStreak: 0,
  maxBankrollFraction: 1,
  maxDailyLossWei: 0n,
  maxConsecutiveLosses: 0,
  cooldownRounds: 0,
  maxExposureWei: bnbToWei(100),
  minWalletBalanceWei: 0n,
  maxGasPriceWei: null,
  stopLossWei: null,
  minConfidence: 0,
  minExpectedEdge: null,
  minSecondsBeforeLock: 5,
  liveRequiresPositiveEv: false,
};
