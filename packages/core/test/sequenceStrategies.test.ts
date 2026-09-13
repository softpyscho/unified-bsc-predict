import { describe, expect, it } from 'vitest';
import type { Direction, OwnTradeView, RoundOutcome, StrategyPlugin } from '../src/index.js';
import {
  alternationStrategy,
  bnbToWei,
  buildContext,
  ensemble,
  markov,
  persistence,
  reversalStrategy,
  sequenceRecovery,
  transitionMatrixStrategy,
} from '../src/index.js';
import { BUFFER, series } from './fixtures.js';

function contextAt(
  outcomes: RoundOutcome[],
  bettingIndex: number,
  ownTrades: OwnTradeView[] = [],
  secondsBeforeLock = 30,
  poolNull = true,
) {
  const rounds = series(outcomes);
  const betting = rounds[bettingIndex]!;
  const now = betting.lockTime! - secondsBeforeLock;
  return buildContext({
    mode: 'BACKTEST',
    now,
    betting: {
      epoch: betting.epoch,
      startTime: betting.startTime!,
      lockTime: betting.lockTime!,
      pool: poolNull ? null : { bullAmount: bnbToWei(1), bearAmount: bnbToWei(1) },
    },
    live: rounds[bettingIndex - 1] ?? null,
    history: rounds,
    lookback: 500,
    ownTrades,
    price: null,
    bankrollWei: bnbToWei(1),
    treasuryFeeBps: 300,
    bufferSeconds: BUFFER,
  });
}

// series() starts epochs at 100, so betting index i is epoch 100+i.
const E = (i: number) => 100 + i;
const own = (
  epoch: number,
  direction: Direction,
  result: OwnTradeView['result'],
  amountBnb = 0.01,
  status: OwnTradeView['status'] = 'SETTLED',
): OwnTradeView => ({
  epoch,
  direction,
  amountBnb,
  status,
  result,
});

describe('persistence', () => {
  const p = persistence as StrategyPlugin;
  it('skips when the sample is too small, even with a clear recent run', () => {
    const ctx = contextAt(['BULL', 'BULL', 'BULL'], 2);
    const sig = p.evaluate(ctx, { ...persistence.defaults, minSampleSize: 5 });
    expect(sig.action).toBe('SKIP');
  });

  it('bets the historically favored continuation once the sample is large enough', () => {
    // UP always followed by UP in this constructed history; one final UP tail to condition on.
    const outcomes: RoundOutcome[] = Array.from({ length: 40 }, () => 'BULL');
    const ctx = contextAt(outcomes, 39);
    const sig = p.evaluate(ctx, { order: 1, minSampleSize: 10, minEdge: 0.01 });
    expect(sig.action).toBe('BUY_UP');
    expect(sig.confidence).toBeGreaterThan(0.9);
  });
});

describe('reversal', () => {
  const p = reversalStrategy as StrategyPlugin;
  it('only fires exactly one round after a fresh direction change', () => {
    const ctx = contextAt(['BULL', 'BULL', 'BULL'], 2); // no change yet
    expect(p.evaluate(ctx, reversalStrategy.defaults).action).toBe('SKIP');
  });

  it('requires the broken run to meet the configured minimum length', () => {
    // Round i is only visible in ctx.history once round i+1 has locked (round i+1 is the "live" round while
    // round i+2 is being decided) — so deciding round 3 is what makes history = [BULL, BEAR] fully known
    // (the run of BULL that broke was length 1).
    const ctx = contextAt(['BULL', 'BEAR', 'BULL', 'BULL'], 3, [], 30, true);
    const sig = p.evaluate(ctx, { ...reversalStrategy.defaults, minPreviousRun: 3 });
    expect(sig.action).toBe('SKIP');
    expect(sig.rationale).toMatch(/only 1 long/);
  });
});

describe('alternation', () => {
  const p = alternationStrategy as StrategyPlugin;
  it('CONTINUE_ALTERNATION requires the minimum trailing length', () => {
    const ctx = contextAt(['BULL', 'BEAR'], 1);
    const sig = p.evaluate(ctx, { ...alternationStrategy.defaults, minAlternationLength: 4 });
    expect(sig.action).toBe('SKIP');
  });

  it('BREAK_FOLLOW_THROUGH only fires immediately after a two-in-a-row break', () => {
    const ctx = contextAt(['BULL', 'BEAR', 'BULL'], 2); // still alternating, no break yet
    const sig = p.evaluate(ctx, { ...alternationStrategy.defaults, mode: 'BREAK_FOLLOW_THROUGH' });
    expect(sig.action).toBe('SKIP');
    expect(sig.rationale).toMatch(/not immediately after/);
  });
});

describe('transition-matrix and markov', () => {
  it('transition-matrix reports the full matrix and requires enough context', () => {
    const p = transitionMatrixStrategy as StrategyPlugin;
    const ctx = contextAt(['BULL', 'BEAR', 'BULL'], 2);
    const sig = p.evaluate(ctx, { order: 1, minSampleSize: 100, minEdge: 0.01 });
    expect(sig.action).toBe('SKIP'); // trivially small sample
    expect(sig.indicators?.matrix).toBeDefined();
  });

  it('markov conditions on the exact trailing N-gram, including mixed (non-streak) contexts', () => {
    const p = markov as StrategyPlugin;
    // Build history where the context [BULL, BEAR] is always followed by BULL.
    const outcomes: RoundOutcome[] = [];
    for (let i = 0; i < 20; i++) outcomes.push('BULL', 'BEAR', 'BULL');
    const ctx = contextAt([...outcomes, 'BULL', 'BEAR'], outcomes.length + 1);
    const sig = p.evaluate(ctx, { order: 2, minSampleSize: 5, minEdge: 0.01 });
    expect(sig.action).toBe('BUY_UP');
  });
});

describe('ensemble', () => {
  it('skips when no component has enough sample and the market edge is unavailable (backtest)', () => {
    const ctx = contextAt(['BULL', 'BEAR', 'BULL'], 2);
    const sig = (ensemble as StrategyPlugin).evaluate(ctx, ensemble.defaults);
    expect(sig.action).toBe('SKIP');
  });
});

describe('sequence-recovery', () => {
  const p = sequenceRecovery as StrategyPlugin;
  const base = { ...sequenceRecovery.defaults, confirmationCount: 1, requiredPreviousStreak: 1 };

  it('places a fresh attempt-1 bet at the configured first ladder step when there is no active sequence', () => {
    const ctx = contextAt(['BULL', 'BULL'], 1); // last completed round was BULL
    const sig = p.evaluate(ctx, { ...base, initialDirection: 'PERSISTENCE' });
    expect(sig.action).toBe('BUY_UP'); // persistence: follow the last winner
    expect(sig.stakeBnb).toBeCloseTo(1 * (base.ladderStep1 / 100), 10); // bankroll 1 BNB
    expect(sig.indicators?.trigger).toBe('FRESH_ENTRY');
    expect(sig.indicators?.recoveryStep).toBe(1);
  });

  // Round i only enters ctx.history once round i+2 is being decided (round i+1 is always the still-running
  // "live" round in between) — so a loss on epoch 101 (index 1) first becomes visible in history when
  // deciding index 3, not index 2. That 2-round lag is real: round 2's own betting window closes before
  // round 1 even resolves (close_1 == lock_2), so index 3 genuinely is "the very round after the loss" in
  // terms of what can actually be bet on.

  it("Confirmation=1: bets the very round after the loss, following the loss round's own (opposite) outcome", () => {
    // I bet BULL on epoch 101 and lost — the round's actual outcome must therefore be BEAR.
    const ctx = contextAt(['BULL', 'BEAR', 'BULL', 'BULL'], 3, [own(E(1), 'BULL', 'LOST')]);
    const sig = p.evaluate(ctx, { ...base, confirmationCount: 1, confirmationAction: 'FOLLOW' });
    expect(sig.action).toBe('BUY_DOWN');
    expect(sig.stakeBnb).toBeCloseTo(1 * (base.ladderStep2 / 100), 10); // attempt 2
    expect(sig.indicators?.trigger).toBe('REVERSAL_CONFIRMATION');
    expect(sig.indicators?.recoveryStep).toBe(2);
  });

  it('Confirmation=2: waits one extra round, then bets on the second confirming round', () => {
    const trades = [own(E(1), 'BULL', 'LOST')];
    // index 2 (epoch 102) is also BEAR, extending the confirming run to 2 once it becomes visible.
    const outcomes: RoundOutcome[] = ['BULL', 'BEAR', 'BEAR', 'BULL', 'BULL'];
    const waiting = p.evaluate(contextAt(outcomes, 3, trades), { ...base, confirmationCount: 2 });
    expect(waiting.action).toBe('SKIP');
    expect(waiting.indicators?.trigger).toBe('CONFIRMATION_PENDING');
    expect(waiting.indicators?.confirmationProgress).toBe(1);

    const confirmed = p.evaluate(contextAt(outcomes, 4, trades), { ...base, confirmationCount: 2 });
    expect(confirmed.action).toBe('BUY_DOWN');
    expect(confirmed.indicators?.confirmationProgress).toBe(2);
  });

  it('FADE confirmation action bets back against the confirmed reversal instead of with it', () => {
    const trades = [own(E(1), 'BULL', 'LOST')];
    const sig = p.evaluate(contextAt(['BULL', 'BEAR', 'BULL', 'BULL'], 3, trades), {
      ...base,
      confirmationCount: 1,
      confirmationAction: 'FADE',
    });
    expect(sig.action).toBe('BUY_UP'); // fades back to the original direction
  });

  it('requires the prior run to meet requiredPreviousStreak before confirming', () => {
    // Prior BULL run is only 1 long; requiredPreviousStreak=2 should block confirmation.
    const trades = [own(E(1), 'BULL', 'LOST')];
    const sig = p.evaluate(contextAt(['BULL', 'BEAR', 'BULL', 'BULL'], 3, trades), {
      ...base,
      confirmationCount: 1,
      requiredPreviousStreak: 2,
    });
    expect(sig.action).toBe('SKIP');
    expect(sig.indicators?.trigger).toBe('REVERSAL_TOO_WEAK');
  });

  it('does not fire while the market has not yet reversed away from the losing direction', () => {
    // I bet BULL, lost this round is impossible to construct without the market being BEAR that round —
    // so test the case where a *subsequent* round reverted back to BULL before confirming. That reversion
    // (index 2) only becomes visible once deciding index 4.
    const trades = [own(E(1), 'BULL', 'LOST')];
    const sig = p.evaluate(contextAt(['BULL', 'BEAR', 'BULL', 'BULL', 'BULL'], 4, trades), {
      ...base,
      confirmationCount: 1,
    });
    expect(sig.action).toBe('SKIP');
    expect(sig.indicators?.trigger).toBe('AWAITING_REVERSAL');
  });

  it('walks the full ladder to step 4, then cools down, then resets to a fresh attempt', () => {
    // Four consecutive losses, each immediately confirmed (confirmationCount=1), alternating my bet
    // direction to match each round's actual (losing) outcome.
    const outcomes: RoundOutcome[] = ['BULL', 'BEAR', 'BEAR', 'BULL', 'BULL']; // 5 rounds, all losses vs my bets below
    const trades = [
      own(E(3), 'BEAR', 'LOST'), // step 4 loss (most recent)
      own(E(2), 'BULL', 'LOST'), // step 3 loss
      own(E(1), 'BEAR', 'LOST'), // step 2 loss
      own(E(0), 'BULL', 'LOST'), // step 1 loss (oldest)
    ];
    const failed = p.evaluate(contextAt(outcomes, 4, trades), base);
    expect(failed.action).toBe('SKIP');
    expect(failed.indicators?.trigger).toBe('RECOVERY_COOLDOWN');

    // Extend far enough past the last loss (epoch 103) to clear the default 2-round cooldown.
    const laterOutcomes: RoundOutcome[] = [...outcomes, 'BULL', 'BULL', 'BULL'];
    const reset = p.evaluate(contextAt(laterOutcomes, 7, trades), base);
    expect(reset.indicators?.trigger).toBe('SEQUENCE_FAILED_RESET');
    expect(reset.indicators?.recoveryStep).toBe(1);
  });

  it('a REFUNDED (cancelled-round) trade is transparent: it neither advances nor resets the ladder', () => {
    const withRefund = [
      own(E(2), 'BULL', 'REFUNDED'), // cancelled round, sandwiched between two losses
      own(E(1), 'BULL', 'LOST'),
    ];
    const withoutRefund = [own(E(1), 'BULL', 'LOST')];
    const a = p.evaluate(contextAt(['BULL', 'BEAR', 'BULL', 'BULL'], 3, withRefund), {
      ...base,
      confirmationCount: 1,
    });
    const b = p.evaluate(contextAt(['BULL', 'BEAR', 'BULL', 'BULL'], 3, withoutRefund), {
      ...base,
      confirmationCount: 1,
    });
    expect(a.indicators?.recoveryStep).toBe(b.indicators?.recoveryStep);
  });

  it('TARGET_RECOVERY sizing falls back to the fixed ladder percentage when no pool is observable (backtest)', () => {
    const trades = [own(E(1), 'BULL', 'LOST', 0.03)];
    const sig = p.evaluate(contextAt(['BULL', 'BEAR', 'BULL', 'BULL'], 3, trades), {
      ...base,
      sizingMode: 'TARGET_RECOVERY',
    });
    expect(sig.action).toBe('BUY_DOWN');
    expect(sig.stakeBnb).toBeCloseTo(1 * (base.ladderStep2 / 100), 10);
    expect(sig.rationale).toMatch(/TARGET_RECOVERY unavailable/);
  });

  it('TARGET_RECOVERY sizes to recoup losses plus target profit when a pool reading is available', () => {
    const trades = [own(E(1), 'BULL', 'LOST', 0.03)];
    const ctx = contextAt(['BULL', 'BEAR', 'BULL', 'BULL'], 3, trades, 30, false); // pool: 1 BNB each side, 3% fee -> payout ~1.94x
    const sig = p.evaluate(ctx, { ...base, sizingMode: 'TARGET_RECOVERY', targetProfitPercent: 1 });
    expect(sig.action).toBe('BUY_DOWN');
    // priorLosses 0.03 + targetProfit 1%*1BNB=0.01 = 0.04, divided by (payout-1).
    const payout = 1.94; // (1+1)*0.97 / 1
    const expected = 0.04 / (payout - 1);
    expect(sig.stakeBnb).toBeCloseTo(expected, 1);
  });
});
