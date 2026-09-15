import { describe, expect, it } from 'vitest';
import type { StrategyContext, StrategyPlugin } from '../src/index.js';
import {
  buildContext,
  decide,
  defaultStrategyConfig,
  followLastWinner,
  momentum,
  parseStrategyConfig,
  streakReversal,
  bnbToWei,
} from '../src/index.js';
import type { RoundOutcome } from '../src/index.js';
import { BUFFER, LOOSE_LIMITS, series } from './fixtures.js';

function ctxAt(
  outcomes: RoundOutcome[],
  bettingIndex: number,
  secondsBeforeLock = 30,
  ownTrades: Parameters<typeof buildContext>[0]['ownTrades'] = [],
) {
  const rounds = series(outcomes);
  const betting = rounds[bettingIndex]!;
  const now = betting.lockTime! - secondsBeforeLock;
  return {
    rounds,
    ctx: buildContext({
      mode: 'BACKTEST',
      now,
      betting: {
        epoch: betting.epoch,
        startTime: betting.startTime!,
        lockTime: betting.lockTime!,
        pool: null,
      },
      live: rounds[bettingIndex - 1] ?? null,
      history: rounds,
      lookback: 50,
      ownTrades,
      price: null,
      bankrollWei: bnbToWei(1),
      treasuryFeeBps: 300,
      bufferSeconds: BUFFER,
    }),
  };
}

describe('buildContext (look-ahead protection)', () => {
  it('only exposes rounds whose result is known at decision time', () => {
    const { ctx, rounds } = ctxAt(['BULL', 'BEAR', 'BULL', 'BEAR', 'BULL', 'BEAR'], 4);
    // Round 3 (live) closes at lock of round 4, after `now`; rounds 4 and 5 are in the future.
    expect(ctx.history.map((r) => r.epoch)).toEqual([rounds[0]!.epoch, rounds[1]!.epoch, rounds[2]!.epoch]);
    expect(ctx.history.every((r) => r.closeTime! <= ctx.now)).toBe(true);
    expect(ctx.live?.epoch).toBe(rounds[3]!.epoch);
    expect(ctx.live?.lockPrice).not.toBeNull();
    expect(ctx.betting.pool).toBeNull();
    expect(ctx.price).toBeNull();
    expect(ctx.betting.secondsToLock).toBe(30);
  });

  it('delays knowledge of a cancellation until close + buffer', () => {
    const outcomes: RoundOutcome[] = ['BULL', 'CANCELLED', 'BULL', 'BULL'];
    // Deciding round 3, 10s before lock; round 1 closed at lock of round 2, i.e. 290s before now.
    expect(ctxAt(outcomes, 3, 10).ctx.history.map((r) => r.outcome)).toEqual(['BULL', 'CANCELLED']);
    // Deciding round 2 at 290s before its lock: round 0 closed 290s ago... round 1 (cancelled) closes at lock 2.
    const early = ctxAt(outcomes, 2, 290).ctx;
    expect(early.history.map((r) => r.outcome)).toEqual(['BULL']);
  });

  it('hides the live round lock price before its lock time', () => {
    const rounds = series(['BULL', 'BULL']);
    const ctx = buildContext({
      mode: 'BACKTEST',
      now: rounds[0]!.lockTime! - 1,
      betting: {
        epoch: rounds[1]!.epoch,
        startTime: rounds[1]!.startTime!,
        lockTime: rounds[1]!.lockTime!,
        pool: null,
      },
      live: rounds[0]!,
      history: rounds,
      lookback: 10,
      ownTrades: [],
      price: { value: 60_100_000_000, updatedAt: rounds[0]!.lockTime! + 100 },
      bankrollWei: 0n,
      treasuryFeeBps: 300,
      bufferSeconds: BUFFER,
    });
    expect(ctx.live?.lockPrice).toBeNull();
    expect(ctx.price).toBeNull(); // observed after `now`
    expect(ctx.history).toHaveLength(0);
  });

  it('exposes own trades most-recent-first, dropping any on or after the betting round', () => {
    // series() starts epochs at 100 by default, so bettingIndex 4 is epoch 104.
    const { ctx } = ctxAt(['BULL', 'BULL', 'BULL', 'BULL', 'BULL'], 4, 30, [
      { epoch: 101, direction: 'BULL', amountBnb: 0.01, status: 'SETTLED', result: 'LOST' },
      { epoch: 103, direction: 'BEAR', amountBnb: 0.03, status: 'SETTLED', result: 'WON' },
      { epoch: 104, direction: 'BULL', amountBnb: 0.06, status: 'CONFIRMED', result: null }, // being decided now
      { epoch: 105, direction: 'BULL', amountBnb: 0.06, status: 'CONFIRMED', result: null }, // future: must not leak
    ]);
    expect(ctx.ownTrades.map((t) => t.epoch)).toEqual([103, 101]);
    expect(ctx.ownTrades[0]).toEqual({
      epoch: 103,
      direction: 'BEAR',
      amountBnb: 0.03,
      status: 'SETTLED',
      result: 'WON',
    });
  });
});

describe('built-in strategies', () => {
  it('follow-last-winner bets the last completed winner and skips ties', () => {
    expect(
      followLastWinner.evaluate(ctxAt(['BEAR', 'BULL', 'BEAR', 'BULL'], 3).ctx, { invert: false }).action,
    ).toBe('BUY_UP');
    expect(
      followLastWinner.evaluate(ctxAt(['BEAR', 'BULL', 'BEAR', 'BULL'], 3).ctx, { invert: true }).action,
    ).toBe('BUY_DOWN');
    expect(
      followLastWinner.evaluate(ctxAt(['BULL', 'TIE', 'BEAR', 'BULL'], 3).ctx, { invert: false }).action,
    ).toBe('SKIP');
    // A cancelled round is ignored; the previous completed round decides (as SimpleBot did).
    expect(
      followLastWinner.evaluate(ctxAt(['BEAR', 'CANCELLED', 'BULL', 'BULL'], 3, 10).ctx, { invert: false })
        .action,
    ).toBe('BUY_DOWN');
  });

  it('momentum follows monotonic close sequences', () => {
    const up = ctxAt(['BULL', 'BULL', 'TIE', 'BULL', 'BULL', 'BEAR', 'BEAR'], 6).ctx;
    expect(momentum.evaluate(up, { window: 5, minMovePct: 0 }).action).toBe('BUY_UP');
    const down = ctxAt(['BEAR', 'BEAR', 'BEAR', 'BEAR', 'BEAR', 'BULL', 'BULL'], 6).ctx;
    expect(momentum.evaluate(down, { window: 5, minMovePct: 0 }).action).toBe('BUY_DOWN');
    const mixed = ctxAt(['BEAR', 'BULL', 'BEAR', 'BULL', 'BEAR', 'BULL', 'BULL'], 6).ctx;
    expect(momentum.evaluate(mixed, { window: 5, minMovePct: 0 }).action).toBe('SKIP');
    expect(momentum.evaluate(up, { window: 5, minMovePct: 5 }).action).toBe('SKIP');
    expect(
      momentum.evaluate(ctxAt(['BULL', 'BULL', 'BULL'], 2).ctx, { window: 5, minMovePct: 0 }).action,
    ).toBe('SKIP');
  });

  it('streak-reversal fades or follows long runs', () => {
    const ctx = ctxAt(['BEAR', 'BULL', 'BULL', 'BULL', 'BULL', 'BEAR', 'BEAR'], 6).ctx;
    expect(streakReversal.evaluate(ctx, { streak: 4, mode: 'FADE' }).action).toBe('BUY_DOWN');
    expect(streakReversal.evaluate(ctx, { streak: 4, mode: 'FOLLOW' }).action).toBe('BUY_UP');
    expect(streakReversal.evaluate(ctx, { streak: 5, mode: 'FADE' }).action).toBe('SKIP');
  });
});

const exploding: StrategyPlugin = {
  id: 'exploding',
  name: 'x',
  version: '1',
  description: '',
  params: [],
  defaults: {},
  lookback: () => 1,
  evaluate() {
    throw new Error('boom');
  },
};

function run(
  plugin: StrategyPlugin,
  overrides: Partial<Parameters<typeof decide>[0]> = {},
  ctx?: StrategyContext,
) {
  const config = defaultStrategyConfig(plugin, 0.01);
  return decide({
    mode: 'PAPER',
    plugin,
    config,
    ctx: ctx ?? ctxAt(['BULL', 'BULL', 'BULL', 'BULL'], 3).ctx,
    limits: LOOSE_LIMITS,
    state: {
      bankrollWei: bnbToWei(1),
      availableWei: bnbToWei(1),
      exposureWei: 0n,
      dailyNetPnlWei: 0n,
      strategyNetPnlWei: 0n,
      lossStreak: 0,
      roundsSinceLastLoss: null,
      alreadyBetThisRound: false,
      roundOpen: true,
      secondsToLock: 30,
      gasPriceWei: null,
      gasReserveWei: 0n,
    },
    gates: [],
    minBetWei: bnbToWei('0.001'),
    treasuryFeeBps: 300,
    ...overrides,
  });
}

describe('decision pipeline', () => {
  it('turns a strategy exception into NO_TRADE — never a trade', () => {
    const d = run(exploding);
    expect(d.kind).toBe('NO_TRADE');
    expect(d.error).toBe('boom');
    expect(d.reason).toBe('STRATEGY_ERROR: boom');
  });

  it('rejects malformed signals', () => {
    const bad: StrategyPlugin = {
      ...exploding,
      evaluate: () => ({ action: 'MOON', confidence: 2 }) as never,
    };
    expect(run(bad).reason).toBe('INVALID_SIGNAL');
  });

  it('keeps waiting until the latest safe entry time', () => {
    const waiting: StrategyPlugin = {
      ...exploding,
      evaluate: () => ({ action: 'WAIT', confidence: 0, rationale: '' }),
    };
    expect(run(waiting).kind).toBe('WAIT');
    const late = ctxAt(['BULL', 'BULL', 'BULL', 'BULL'], 3, 4).ctx;
    expect(run(waiting, {}, late).reason).toMatch(/^ENTRY_WINDOW_CLOSED/);
  });

  it('applies the direction filter', () => {
    const plugin = followLastWinner as StrategyPlugin;
    const config = { ...defaultStrategyConfig(plugin, 0.01), directions: 'BEAR_ONLY' as const };
    expect(run(plugin, { config }).reason).toMatch(/^DIRECTION_FILTER/);
  });

  it('approves, sizes and records every risk check', () => {
    const d = run(followLastWinner as StrategyPlugin, {
      limits: { ...LOOSE_LIMITS, maxStakeWei: bnbToWei('0.005') },
    });
    expect(d.kind).toBe('TRADE');
    expect(d.direction).toBe('BULL');
    expect(d.intendedStakeWei).toBe(bnbToWei('0.01'));
    expect(d.stakeWei).toBe(bnbToWei('0.005'));
    expect(d.checks.find((c) => c.rule === 'STAKE_CAP')?.detail).toMatch(/clamped/);
  });

  it('reports the first failed risk rule', () => {
    const d = run(followLastWinner as StrategyPlugin, {
      gates: [{ rule: 'BOT_RUNNING', passed: false, detail: 'bot is PAUSED' }],
    });
    expect(d.kind).toBe('NO_TRADE');
    expect(d.reason).toBe('RISK_REJECTED: BOT_RUNNING: bot is PAUSED');
    expect(d.signal?.action).toBe('BUY_UP');
  });
});

describe('strategy config', () => {
  it('fills defaults and validates', () => {
    const ok = parseStrategyConfig(momentum as StrategyPlugin, {
      params: { window: 7 },
      limits: { maxStakeBnb: 0.01 },
    });
    expect(ok.ok && ok.value.params).toEqual({ window: 7, minMovePct: 0 });
    const bad = parseStrategyConfig(momentum as StrategyPlugin, {
      params: { window: 1, nope: 1 },
      timing: { entrySecondsBeforeLock: 5, minSecondsBeforeLock: 10 },
      limits: { bogus: 1 },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toEqual(
        expect.arrayContaining([
          'params.unknown param "nope"',
          'params.window: must be >= 3',
          'timing.minSecondsBeforeLock must be smaller than entrySecondsBeforeLock',
          'limits.bogus is not a known limit',
        ]),
      );
    }
  });
});
