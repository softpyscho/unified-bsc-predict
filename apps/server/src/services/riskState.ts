/** Builds the RiskState consumed by the core risk engine from the ledger (and, for LIVE, fresh chain reads). */
import type { RiskState, TradeMode } from '@bsc/core';
import { tradeNetPnl } from '@bsc/core';
import type { StoredRound, Trade } from '../repositories/index.js';
import type { Ctx } from './context.js';
import type { PortfolioService } from './portfolio.js';

/** Conservative gas budget for one bet (observed ~90-110k on BSC) and one claim. */
export const BET_GAS_ESTIMATE = 200_000n;

export interface RiskStateInput {
  mode: TradeMode;
  strategyId: number;
  marketId: number;
  round: StoredRound;
  now: number;
}

function ledgerStats(trades: readonly Trade[], strategyId: number, dayStart: number) {
  let dailyNet = 0n;
  let strategyNet = 0n;
  for (const t of trades) {
    const net = tradeNetPnl(t);
    if (net === null) continue;
    const at = t.status === 'SETTLED' ? (t.settledAt ?? 0) : Math.floor(t.placedAt / 1000);
    if (at >= dayStart) dailyNet += net;
    if (t.strategyId === strategyId) strategyNet += net;
  }
  const settled = trades
    .filter((t) => t.strategyId === strategyId && t.status === 'SETTLED' && t.result !== 'REFUNDED')
    .sort((a, b) => b.epoch - a.epoch);
  let lossStreak = 0;
  for (const t of settled) {
    if (t.result !== 'LOST') break;
    lossStreak++;
  }
  const lastLoss = settled.find((t) => t.result === 'LOST');
  return { dailyNet, strategyNet, lossStreak, lastLossEpoch: lastLoss?.epoch ?? null };
}

export class RiskStateBuilder {
  constructor(
    private readonly ctx: Ctx,
    private readonly portfolio: PortfolioService,
  ) {}

  async build(i: RiskStateInput): Promise<RiskState> {
    const { repos, reader, config } = this.ctx;
    const d = new Date(i.now * 1000);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
    const secondsToLock = (i.round.lockTime ?? 0) - i.now;
    const roundOpen = i.round.status === 'OPEN' && secondsToLock > 0;

    if (i.mode === 'PAPER') {
      const trades = repos.trades.all({ mode: 'PAPER' });
      const acct = this.portfolio.paperAccount();
      const s = ledgerStats(trades, i.strategyId, dayStart);
      return {
        bankrollWei: acct.balance ?? 0n,
        availableWei: acct.available ?? 0n,
        exposureWei: acct.exposure,
        dailyNetPnlWei: s.dailyNet,
        strategyNetPnlWei: s.strategyNet,
        lossStreak: s.lossStreak,
        roundsSinceLastLoss: s.lastLossEpoch === null ? null : i.round.epoch - s.lastLossEpoch,
        alreadyBetThisRound: trades.some((t) => t.strategyId === i.strategyId && t.roundId === i.round.id),
        roundOpen,
        secondsToLock,
        gasPriceWei: null,
        gasReserveWei: config.simulatedGasPerBetWei,
      };
    }

    const wallet = repos.wallets.signer();
    if (!wallet || !this.ctx.writer) {
      return {
        bankrollWei: 0n,
        availableWei: 0n,
        exposureWei: 0n,
        dailyNetPnlWei: 0n,
        strategyNetPnlWei: 0n,
        lossStreak: 0,
        roundsSinceLastLoss: null,
        alreadyBetThisRound: false,
        roundOpen,
        secondsToLock,
        gasPriceWei: null,
        gasReserveWei: 0n,
      };
    }
    const address = wallet.address as `0x${string}`;
    // Fresh, authoritative reads: never size or approve a live bet from cached balances.
    const [balance, gasPrice, ledger] = await Promise.all([
      reader.getBalance(address),
      reader.getGasPrice(),
      reader.getLedger(i.round.epoch, address),
    ]);
    this.portfolio.setLiveBalance(balance);
    const acct = this.portfolio.liveAccount(wallet.id);
    const trades = repos.trades.all({ mode: 'LIVE', walletId: wallet.id });
    const s = ledgerStats(trades, i.strategyId, dayStart);
    return {
      bankrollWei: balance + acct.exposure + acct.claimable,
      availableWei: balance,
      exposureWei: acct.exposure,
      dailyNetPnlWei: s.dailyNet,
      strategyNetPnlWei: s.strategyNet,
      lossStreak: s.lossStreak,
      roundsSinceLastLoss: s.lastLossEpoch === null ? null : i.round.epoch - s.lastLossEpoch,
      alreadyBetThisRound:
        repos.trades.findLive(wallet.id, i.marketId, i.round.epoch) !== undefined || ledger.amount > 0n,
      roundOpen,
      secondsToLock,
      gasPriceWei: gasPrice,
      gasReserveWei: BET_GAS_ESTIMATE * gasPrice * 2n,
    };
  }
}
