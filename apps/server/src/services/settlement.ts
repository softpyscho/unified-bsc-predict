/**
 * Settlement: CONFIRMED → SETTLED once the round is final. LIVE payouts use the exact contract formula on the
 * on-chain pool (which already contains the bet); PAPER payouts add the hypothetical stake to the pool.
 */
import {
  claimStatusFor,
  resultFor,
  settledPayout,
  simulatedPayout,
  tradeNetPnl,
  weiToBnbString,
} from '@bsc/core';
import type { StoredRound, Trade } from '../repositories/index.js';
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';

export class SettlementService {
  constructor(private readonly ctx: Ctx) {}

  settleRounds(rounds: readonly StoredRound[]): number {
    let n = 0;
    for (const r of rounds) {
      if (!r.isFinal) continue;
      for (const t of this.ctx.repos.trades.forRound(r.id)) {
        if (t.status === 'CONFIRMED' && this.settle(t, r)) n++;
      }
    }
    return n;
  }

  settleAll(): number {
    let n = 0;
    const cache = new Map<number, StoredRound | undefined>();
    for (const t of this.ctx.repos.trades.settleable()) {
      if (!cache.has(t.roundId)) cache.set(t.roundId, this.ctx.repos.rounds.getById(t.roundId));
      const r = cache.get(t.roundId);
      if (r?.isFinal && this.settle(t, r)) n++;
    }
    return n;
  }

  private settle(t: Trade, r: StoredRound): boolean {
    const { repos, config } = this.ctx;
    const market = repos.markets.get(t.marketId)!;
    const outcome = r.outcome!;
    const payout =
      t.mode === 'LIVE'
        ? settledPayout(r, outcome, t.direction, t.amount)
        : simulatedPayout(r, outcome, t.direction, t.amount, market.treasuryFeeBps);
    const result = resultFor(outcome, t.direction);
    const claimStatus = claimStatusFor(t.mode, result);
    const claimGasCost =
      t.mode === 'PAPER' && result !== 'LOST' ? config.simulatedGasPerClaimWei : t.claimGasCost;
    const buffer = market.bufferSeconds ?? 30;
    const closeTime = r.closeTime ?? Math.floor(this.ctx.clock.nowMs() / 1000);
    const settledAt = outcome === 'CANCELLED' ? closeTime + buffer : closeTime;
    const netPnl = tradeNetPnl({
      status: 'SETTLED',
      amount: t.amount,
      payout,
      gasCost: t.gasCost,
      claimGasCost,
    });
    let settled: Trade;
    try {
      settled = repos.trades.transition(
        t.id,
        'CONFIRMED',
        'SETTLED',
        { result, payout, grossPnl: payout - t.amount, netPnl, claimStatus, claimGasCost, settledAt },
        `round ${r.epoch} ${outcome}: ${result}`,
      );
    } catch (err) {
      this.ctx.log.app.warn({ err, tradeId: t.id }, 'settlement skipped (trade changed concurrently)');
      return false;
    }
    const base = {
      component: 'settlement',
      marketId: t.marketId,
      epoch: t.epoch,
      strategyId: t.strategyId,
      tradeId: t.id,
      txHash: t.txHash,
    };
    this.ctx.audit.record({
      ...base,
      severity: 'INFO',
      type: AuditType.TRADE_SETTLED,
      message: `${t.mode} ${t.direction} on round ${t.epoch} ${result}: payout ${weiToBnbString(payout)} BNB, net ${weiToBnbString(netPnl ?? 0n)} BNB`,
    });
    if (claimStatus === 'UNCLAIMED') {
      this.ctx.audit.record({
        ...base,
        severity: 'INFO',
        type: AuditType.PAYOUT_DETECTED,
        message: `${weiToBnbString(payout)} BNB claimable for round ${t.epoch} (${result})`,
      });
    }
    this.ctx.bus.emit('trade', settled);
    return true;
  }
}
