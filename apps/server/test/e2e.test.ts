/**
 * End-to-end cycles on the simulated contract:
 *   new round → ingestion → strategy signal → risk approval → bet (paper or live) → round settlement →
 *   payout/claim → P&L → portfolio → API/dashboard data and SSE events.
 */
import { bnbToWei, simulatedPayout, tradeNetPnl } from '@bsc/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { AppEvent } from '../src/services/events.js';
import { GAS_COST } from './fakeChain.js';
import type { Harness } from './harness.js';
import { bearer, makeHarness, playRound, tick } from './harness.js';

const PRICES = [600, 601, 602, 601, 600, 601, 603, 602].map((p) => p * 1e8);

async function enable(h: Harness, flags: { paper: boolean; live: boolean }) {
  const s = (await h.app.repos.strategies.bySlug('follow-last-winner'))!;
  await h.app.repos.strategies.setFlags(s.id, {
    enabled: true,
    paperTradingEnabled: flags.paper,
    liveTradingEnabled: flags.live,
  });
  return s;
}

describe('paper trading end-to-end', () => {
  it('runs the full pipeline and exposes the results through the API', async () => {
    const h = await makeHarness();
    const events: AppEvent[] = [];
    h.app.bus.on((e) => events.push(e));
    await h.app.recovery.run();
    const strategy = await enable(h, { paper: true, live: false });
    await h.app.bot.start('test');

    const epochs: number[] = [];
    for (const p of PRICES) epochs.push(await playRound(h, p));
    // Two more executions so every traded round becomes final.
    h.chain.execute(604e8);
    await tick(h);

    const { repos } = h.app;
    const decisions = (await repos.decisions.list({ strategyId: strategy.id }, { limit: 100, offset: 0 }))
      .rows;
    // Rounds 1 and 2 have no completed round to follow; every later round gets a TRADE decision.
    expect(decisions).toHaveLength(epochs.length);
    const trades = await repos.trades.all({ mode: 'PAPER' });
    expect(trades.length).toBe(epochs.length - 2);
    expect(
      decisions.filter((d) => d.decision === 'NO_TRADE').every((d) => d.reason.startsWith('STRATEGY_SKIP')),
    ).toBe(true);

    // Every decision records its full risk evaluation and inputs.
    const traded = decisions.find((d) => d.decision === 'TRADE')!;
    expect(traded.riskChecks.map((c) => c.rule)).toContain('MAX_EXPOSURE');
    expect(traded.inputs).toMatchObject({ historyRounds: expect.any(Number), pool: expect.any(Object) });

    // Signals follow the round two epochs earlier (the last one known at decision time).
    const market = h.app.markets.tradable();
    for (const t of trades) {
      const known = (await repos.rounds.get(market.id, t.epoch - 2))!;
      expect(t.direction).toBe(known.outcome);
    }

    const settled = trades.filter((t) => t.status === 'SETTLED');
    expect(settled.length).toBe(trades.length);
    for (const t of settled) {
      const r = (await repos.rounds.get(market.id, t.epoch))!;
      expect(t.payout).toBe(simulatedPayout(r, r.outcome!, t.direction, t.amount, 300));
      expect(t.netPnl).toBe(tradeNetPnl(t));
    }

    const account = await h.app.portfolio.paperAccount();
    const realized = settled.reduce((a, t) => a + (t.netPnl ?? 0n), 0n);
    expect(account.realizedPnl).toBe(realized);
    expect(account.available).toBe(h.app.config.paperStartingBankrollWei + realized);

    const server = await buildServer(h.app);
    const res = await server.inject({
      method: 'GET',
      url: '/api/trades?mode=PAPER&limit=100',
      headers: bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      rows: { running: { cumulativePnl: string } | null }[];
      summary: { netPnl: string };
    };
    expect(body.total).toBe(trades.length);
    expect(BigInt(body.summary.netPnl)).toBe(realized);
    const portfolio = (
      await server.inject({ method: 'GET', url: '/api/portfolio?mode=PAPER', headers: bearer })
    ).json() as {
      report: { summary: { netPnl: string; settledTrades: number }; equity: unknown[] };
    };
    expect(BigInt(portfolio.report.summary.netPnl)).toBe(realized);
    expect(portfolio.report.equity).toHaveLength(settled.length);
    const roundView = (
      await server.inject({ method: 'GET', url: `/api/rounds/${trades[0]!.epoch}`, headers: bearer })
    ).json() as {
      decisions: { reason: string }[];
      trades: unknown[];
    };
    expect(roundView.decisions[0]!.reason).toMatch(/^APPROVED/);
    expect(roundView.trades).toHaveLength(1);
    await server.close();

    // The dashboard's live stream saw the lifecycle.
    const types = new Set(events.map((e) => e.type));
    for (const t of ['market', 'decision', 'trade', 'audit', 'bot']) expect(types).toContain(t);
    expect(await repos.audit.list({ type: 'TRADE_SETTLED' }, 100)).toHaveLength(settled.length);
    await h.app.close();
  });

  it('refunds a paper bet when the round is cancelled', async () => {
    const h = await makeHarness();
    await h.app.recovery.run();
    await enable(h, { paper: true, live: false });
    await h.app.bot.start('test');
    for (const p of [600, 601, 602]) await playRound(h, p * 1e8);
    const epoch = h.chain.currentEpoch;
    const round = h.chain.round(epoch);
    h.chain.setTime(round.lockTime! - 20);
    await tick(h);
    const trade = (await h.app.repos.trades.all({ mode: 'PAPER', epoch }))[0]!;
    expect(trade.status).toBe('CONFIRMED');
    h.chain.advance(1_000); // operator stalls past lock + buffer: this round can never lock
    h.chain.execute(605e8);
    await tick(h);
    const after = (await h.app.repos.trades.get(trade.id))!;
    expect(after.status).toBe('SETTLED');
    expect(after.result).toBe('REFUNDED');
    expect(after.payout).toBe(trade.amount);
    expect(after.netPnl).toBe(-(h.app.config.simulatedGasPerBetWei + h.app.config.simulatedGasPerClaimWei));
    await h.app.close();
  });

  it('records why a strategy did not trade live when the live gate is closed', async () => {
    const h = await makeHarness();
    await h.app.recovery.run();
    await enable(h, { paper: false, live: true });
    await h.app.bot.start('test');
    for (const p of [600, 601, 602, 603]) await playRound(h, p * 1e8);
    const live = (await h.app.repos.decisions.list({ mode: 'LIVE' }, { limit: 10, offset: 0 })).rows;
    const withSignal = live.filter((d) => d.signal === 'BUY_UP' || d.signal === 'BUY_DOWN');
    expect(withSignal.length).toBeGreaterThan(0);
    for (const d of withSignal) {
      expect(d.decision).toBe('NO_TRADE');
      expect(d.reason).toMatch(/^RISK_REJECTED: LIVE_TRADING_ENABLED/);
    }
    expect(await h.app.repos.trades.all({ mode: 'LIVE' })).toHaveLength(0);
    await h.app.close();
  });

  it('isolates a broken strategy configuration (recorded NO_TRADE, others unaffected)', async () => {
    const h = await makeHarness();
    await h.app.recovery.run();
    const s = await enable(h, { paper: true, live: false });
    const momentum = (await h.app.repos.strategies.bySlug('momentum'))!;
    await h.app.repos.strategies.setFlags(momentum.id, { enabled: true });
    await h.app.repos.db.run('UPDATE strategies SET config = ? WHERE id = ?', [
      '{"params":{"window":-5}}',
      momentum.id,
    ]);
    await h.app.bot.start('test');
    for (const p of [600, 601, 602, 603]) await playRound(h, p * 1e8);
    const broken = (await h.app.repos.decisions.list({ strategyId: momentum.id }, { limit: 10, offset: 0 }))
      .rows;
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.every((d) => d.decision === 'NO_TRADE' && d.reason.startsWith('CONFIG_INVALID'))).toBe(
      true,
    );
    expect((await h.app.repos.trades.all({ strategyId: s.id })).length).toBeGreaterThan(0);
    await h.app.close();
  });

  it('emergency stop halts evaluation immediately and requires an explicit reset', async () => {
    const h = await makeHarness();
    await h.app.recovery.run();
    await enable(h, { paper: true, live: false });
    await h.app.bot.start('test');
    for (const p of [600, 601, 602]) await playRound(h, p * 1e8);
    const before = (await h.app.repos.decisions.list({}, { limit: 100, offset: 0 })).total;
    await h.app.bot.emergencyStop('test');
    await playRound(h, 603e8);
    expect((await h.app.repos.decisions.list({}, { limit: 100, offset: 0 })).total).toBe(before);
    await expect(h.app.bot.start()).rejects.toThrow(/reset/);
    await expect(h.app.bot.resetEmergency(false)).rejects.toThrow(/acknowledge/);
    expect((await h.app.bot.resetEmergency(true)).status).toBe('STOPPED');
    expect((await h.app.repos.audit.list({ type: 'EMERGENCY_STOP' }, 5))[0]!.severity).toBe('CRITICAL');
    await h.app.close();
  });
});

describe('live trading end-to-end (simulated contract)', () => {
  async function liveHarness(opts: Parameters<typeof makeHarness>[0] = {}) {
    const h = await makeHarness({ live: true, ...opts });
    h.chain.fund(h.app.config.walletAddress!, bnbToWei('1'));
    await h.app.recovery.run();
    await enable(h, { paper: false, live: true });
    await h.app.bot.start('test');
    await h.app.bot.armLive('ENABLE LIVE TRADING');
    return h;
  }

  it('bets, confirms, settles and claims with exact wallet accounting', async () => {
    const h = await liveHarness();
    const wallet = h.app.config.walletAddress!;
    const start = await h.chain.getBalance(wallet);
    for (const p of PRICES) await playRound(h, p);
    h.chain.execute(604e8);
    await tick(h);

    const trades = await h.app.repos.trades.all({ mode: 'LIVE' });
    expect(trades.length).toBe(PRICES.length - 2);
    for (const t of trades) {
      expect(t.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(t.gasCost).toBe(GAS_COST);
      expect(t.status).toBe('SETTLED');
      const ledger = await h.chain.getLedger(t.epoch, wallet);
      expect(ledger.amount).toBe(t.amount); // exactly one on-chain bet per trade
    }
    expect(h.writer!.sent.length).toBe(trades.length);

    const claim = await h.app.claims.run({ force: true });
    const wins = trades.filter((t) => t.result !== 'LOST');
    expect(claim.claimedEpochs.sort()).toEqual(wins.map((t) => t.epoch).sort());
    const after = await h.app.repos.trades.all({ mode: 'LIVE' });
    expect(after.filter((t) => t.claimStatus === 'CLAIMED')).toHaveLength(wins.length);

    // Wallet balance change == realized net P&L in the ledger (stakes, payouts, bet gas and claim gas).
    const end = await h.chain.getBalance(wallet);
    const realized = after.reduce((a, t) => a + (t.netPnl ?? 0n), 0n);
    expect(end - start).toBe(realized);
    expect(await h.app.repos.audit.list({ type: 'PAYOUT_CLAIMED' }, 5)).toHaveLength(1);
    await h.app.close();
  });

  it('rejects before submission when the wallet cannot afford the bet', async () => {
    // Fraction cap off so the 0.01 BNB stake is not clamped below the contract minimum first.
    const h = await makeHarness({ live: true, env: { MAX_BANKROLL_FRACTION: '1' } });
    h.chain.fund(h.app.config.walletAddress!, bnbToWei('0.005'));
    await h.app.recovery.run();
    await enable(h, { paper: false, live: true });
    await h.app.bot.start('test');
    await h.app.bot.armLive('ENABLE LIVE TRADING');
    for (const p of [600, 601, 602, 603]) await playRound(h, p * 1e8);
    const d = (
      await h.app.repos.decisions.list({ mode: 'LIVE', decision: 'NO_TRADE' }, { limit: 10, offset: 0 })
    ).rows.find((x) => x.signal !== 'SKIP');
    expect(d?.reason).toMatch(/SUFFICIENT_BALANCE/);
    expect(h.writer!.sent).toHaveLength(0);
    await h.app.close();
  });

  it('trips the circuit breaker after repeated execution failures', async () => {
    const h = await liveHarness();
    for (const p of [600, 601]) await playRound(h, p * 1e8);
    h.writer!.fault = 'reject-insufficient';
    await playRound(h, 602e8);
    h.writer!.fault = 'reject-insufficient';
    await playRound(h, 603e8);
    const failed = await h.app.repos.trades.all({ mode: 'LIVE', status: 'FAILED' });
    expect(failed).toHaveLength(2);
    expect(failed[0]!.errorClass).toBe('INSUFFICIENT_FUNDS');
    const bot = await h.app.bot.view();
    expect(bot.status).toBe('PAUSED');
    expect(bot.liveArmed).toBe(false);
    expect(await h.app.repos.audit.list({ type: 'RISK_LIMIT_TRIGGERED' }, 5)).toHaveLength(1);
    await h.app.close();
  });

  it('resolves an ambiguous broadcast from the receipt without re-sending', async () => {
    const h = await liveHarness();
    for (const p of [600, 601]) await playRound(h, p * 1e8);
    h.writer!.fault = 'network-after-send';
    const epoch = h.chain.currentEpoch;
    h.chain.setTime(h.chain.round(epoch).lockTime! - 20);
    await tick(h);
    const t = (await h.app.repos.trades.all({ mode: 'LIVE', epoch }))[0]!;
    expect(t.status).toBe('SUBMITTING');
    const res = await h.app.txReconciler.run();
    expect(res.confirmed).toBe(1);
    expect((await h.app.repos.trades.get(t.id))!.status).toBe('CONFIRMED');
    expect(h.writer!.sent).toHaveLength(1);
    await h.app.close();
  });

  it('recovers after a crash: no blind re-submission, dropped bet marked failed, live disarmed', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-db-')), 'pg');
    const h1 = await liveHarness({ env: { DATABASE_URL: `pglite:${dir}` } });
    for (const p of [600, 601]) await playRound(h1, p * 1e8);
    h1.writer!.fault = 'network-not-sent'; // process "dies" with the outcome unknown
    const epoch = h1.chain.currentEpoch;
    h1.chain.setTime(h1.chain.round(epoch).lockTime! - 20);
    await tick(h1);
    const pending = (await h1.app.repos.trades.all({ mode: 'LIVE', epoch }))[0]!;
    expect(pending.status).toBe('SUBMITTING');
    await h1.app.close();

    const h2 = await makeHarness({
      live: true,
      chain: h1.chain,
      privateKey: h1.privateKey!,
      env: { DATABASE_URL: `pglite:${dir}` },
    });
    await h2.app.recovery.run();
    expect((await h2.app.bot.view()).liveArmed).toBe(false); // BOT_AUTO_RESUME_LIVE defaults to false
    expect((await h2.app.repos.trades.get(pending.id))!.status).toBe('SUBMITTING'); // still before lock: undecided
    h2.chain.execute(602e8);
    h2.chain.advance(60);
    await h2.app.txReconciler.run();
    const resolved = (await h2.app.repos.trades.get(pending.id))!;
    expect(resolved.status).toBe('FAILED');
    expect(resolved.errorClass).toBe('DROPPED');
    expect((await h2.chain.getLedger(epoch, h2.app.config.walletAddress!)).amount).toBe(0n);
    expect(h2.writer!.sent).toHaveLength(0);
    await h2.app.close();
  });

  it('imports bets made outside the app and detects external claims', async () => {
    const h = await liveHarness();
    await h.app.bot.disarmLive('test');
    const wallet = h.app.config.walletAddress!;
    for (const p of [600, 601]) await playRound(h, p * 1e8);
    const epoch = h.chain.currentEpoch;
    h.chain.setTime(h.chain.round(epoch).startTime! + 20);
    h.chain.externalBet(wallet, 'BULL', bnbToWei('0.002')); // e.g. placed via the PancakeSwap UI
    await playRound(h, 602e8, false);
    h.chain.execute(603e8);
    await tick(h);
    const res = await h.app.walletSync.syncAll();
    expect(res[0]!.imported).toBe(1);
    const t = (await h.app.repos.trades.all({ mode: 'LIVE', source: 'IMPORTED' }))[0]!;
    expect(t.epoch).toBe(epoch);
    expect(t.status).toBe('SETTLED');
    await h.app.close();
  });
});
