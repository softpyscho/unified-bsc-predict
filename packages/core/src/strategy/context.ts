/**
 * Look-ahead-safe context construction. The only way strategies receive data.
 *
 * Visibility rules at decision time `now`:
 *  - an ENDED round is known once `closeTime <= now` (its end tx is mined at/after close);
 *  - a CANCELLED round is only known once `closeTime + bufferSeconds <= now`;
 *  - the live round's lock price is known once `lockTime <= now`; its close is never known;
 *  - the betting round's pool is only passed when it was actually observed (live/paper), never in backtests.
 */
import type { Direction, FinalRound, RoundRecord } from '../round.js';
import { payoutMultiplier, toRoundView } from '../round.js';
import type { RoundView } from '../round.js';
import type { RunMode, TradeResult, TradeStatus } from '../trade.js';
import { priceToUsd, weiToBnb } from '../units.js';
import type { OwnTradeView, StrategyContext } from './types.js';

/**
 * How many of the strategy's own past trades to expose. Trades are far sparser than rounds (a strategy may
 * skip many rounds between bets), so this is a small fixed cap rather than tied to the plugin's round lookback
 * — generous enough for a 4-step recovery ladder plus surrounding context.
 */
export const OWN_TRADES_LOOKBACK = 20;

export interface ContextInput {
  mode: RunMode;
  now: number;
  betting: {
    epoch: number;
    startTime: number;
    lockTime: number;
    pool: { bullAmount: bigint; bearAmount: bigint } | null;
  };
  live: RoundRecord | null;
  /** Final rounds in ascending epoch order. May contain rounds not yet visible at `now`; they are dropped. */
  history: readonly FinalRound[];
  /** Only history[0 .. historyEnd) is considered (lets backtests avoid copying). Defaults to history.length. */
  historyEnd?: number;
  lookback: number;
  /** This strategy's own past trades, any order; filtered to epoch < betting.epoch and capped, most-recent-first. */
  ownTrades: readonly {
    epoch: number;
    direction: Direction;
    amountBnb: number;
    status: TradeStatus;
    result: TradeResult | null;
  }[];
  price: { value: number; updatedAt: number } | null;
  bankrollWei: bigint;
  treasuryFeeBps: number;
  bufferSeconds: number;
}

export function isKnownAt(r: FinalRound, now: number, bufferSeconds: number): boolean {
  if (r.closeTime === null) return false;
  const knownAt = r.outcome === 'CANCELLED' ? r.closeTime + bufferSeconds : r.closeTime;
  return knownAt <= now;
}

export function buildContext(input: ContextInput): StrategyContext {
  const { now, betting } = input;
  const history: RoundView[] = [];
  const end = Math.min(input.historyEnd ?? input.history.length, input.history.length);
  for (let i = end - 1; i >= 0 && history.length < input.lookback; i--) {
    const r = input.history[i]!;
    if (r.epoch >= betting.epoch) continue;
    if (!isKnownAt(r, now, input.bufferSeconds)) continue;
    history.push(toRoundView(r, r.outcome, input.treasuryFeeBps));
  }
  history.reverse();

  const live =
    input.live && input.live.epoch === betting.epoch - 1
      ? {
          epoch: input.live.epoch,
          lockTime: input.live.lockTime,
          closeTime: input.live.closeTime,
          lockPrice:
            input.live.lockTime !== null && input.live.lockTime <= now
              ? priceToUsd(input.live.lockPrice)
              : null,
        }
      : null;

  // Defence in depth: the caller already only supplies trades that exist as of `now` (a persisted ledger
  // query, or a backtest state settled up to `now`), but a trade on the round being decided right now — or
  // any later round — can never legitimately be "own history" for this decision.
  const ownTrades: OwnTradeView[] = input.ownTrades
    .filter((t) => t.epoch < betting.epoch)
    .slice()
    .sort((a, b) => b.epoch - a.epoch)
    .slice(0, OWN_TRADES_LOOKBACK)
    .map((t) => ({
      epoch: t.epoch,
      direction: t.direction,
      amountBnb: t.amountBnb,
      status: t.status,
      result: t.result,
    }));

  const pool = betting.pool
    ? {
        bullAmount: weiToBnb(betting.pool.bullAmount),
        bearAmount: weiToBnb(betting.pool.bearAmount),
        totalAmount: weiToBnb(betting.pool.bullAmount + betting.pool.bearAmount),
        bullPayout: payoutMultiplier(betting.pool, 'BULL', input.treasuryFeeBps),
        bearPayout: payoutMultiplier(betting.pool, 'BEAR', input.treasuryFeeBps),
      }
    : null;

  return {
    mode: input.mode,
    now,
    betting: {
      epoch: betting.epoch,
      startTime: betting.startTime,
      lockTime: betting.lockTime,
      secondsToLock: betting.lockTime - now,
      pool,
    },
    live,
    history,
    ownTrades,
    price:
      input.price && input.price.updatedAt <= now
        ? { value: input.price.value / 1e8, updatedAt: input.price.updatedAt }
        : null,
    bankrollBnb: weiToBnb(input.bankrollWei),
  };
}
