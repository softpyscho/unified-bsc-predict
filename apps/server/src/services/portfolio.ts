/** Portfolio accounting over the trade ledger. PAPER and LIVE are always computed separately. */
import type { LedgerEntry, PortfolioReport, TradeMode } from '@bsc/core';
import { computePortfolio, computeSummary, downsample, isOpenStatus, tradeNetPnl } from '@bsc/core';
import type { Trade } from '../repositories/index.js';
import type { TradeFilter } from '../repositories/trades.js';
import type { Ctx } from './context.js';

export type PortfolioMode = TradeMode | 'ALL';

export interface AccountState {
  mode: TradeMode;
  walletId: number | null;
  startingBankroll: bigint | null;
  /** CONFIGURED = PAPER_STARTING_BANKROLL; IMPLIED = balance + open stakes + unclaimed − realized P&L. */
  bankrollBasis: 'CONFIGURED' | 'IMPLIED' | 'NONE';
  balance: bigint | null;
  available: bigint | null;
  exposure: bigint;
  claimable: bigint;
  realizedPnl: bigint;
  balanceObservedAt: number | null;
}

export interface PortfolioQuery {
  mode: PortfolioMode;
  walletId?: number;
  strategyId?: number;
  marketId?: number;
  fromMs?: number;
  toMs?: number;
}

const EQUITY_POINTS = 1_500;

export class PortfolioService {
  private liveBalance: { wei: bigint; at: number } | null = null;

  constructor(private readonly ctx: Ctx) {}

  setLiveBalance(wei: bigint): void {
    this.liveBalance = { wei, at: this.ctx.clock.nowMs() };
  }

  async toEntries(trades: readonly Trade[]): Promise<LedgerEntry[]> {
    const strategies = new Map((await this.ctx.repos.strategies.list()).map((s) => [s.id, s.slug]));
    const markets = new Map((await this.ctx.repos.markets.list()).map((m) => [m.id, m.slug]));
    return trades.map((t) => ({
      id: t.id,
      mode: t.mode,
      epoch: t.epoch,
      placedAt: Math.floor(t.placedAt / 1000),
      settledAt: t.settledAt,
      strategy: t.strategyId === null ? null : (strategies.get(t.strategyId) ?? `#${t.strategyId}`),
      market: markets.get(t.marketId) ?? `#${t.marketId}`,
      direction: t.direction,
      amount: t.amount,
      status: t.status,
      result: t.result,
      payout: t.payout,
      gasCost: t.gasCost,
      claimGasCost: t.claimGasCost,
    }));
  }

  async paperAccount(): Promise<AccountState> {
    const start = this.ctx.config.paperStartingBankrollWei;
    let cash = start;
    let exposure = 0n;
    let realized = 0n;
    for (const t of await this.ctx.repos.trades.all({ mode: 'PAPER' })) {
      if (t.status === 'FAILED') continue;
      cash -= t.amount + (t.gasCost ?? 0n);
      if (t.status === 'SETTLED') {
        cash += (t.payout ?? 0n) - (t.claimGasCost ?? 0n);
        realized += tradeNetPnl(t) ?? 0n;
      } else if (isOpenStatus(t.status)) {
        exposure += t.amount;
      }
    }
    return {
      mode: 'PAPER',
      walletId: null,
      startingBankroll: start,
      bankrollBasis: 'CONFIGURED',
      balance: cash + exposure,
      available: cash,
      exposure,
      claimable: 0n,
      realizedPnl: realized,
      balanceObservedAt: this.ctx.clock.nowMs(),
    };
  }

  async liveAccount(walletId?: number): Promise<AccountState> {
    const signer = await this.ctx.repos.wallets.signer();
    const id = walletId ?? signer?.id ?? null;
    let exposure = 0n;
    let claimable = 0n;
    let realized = 0n;
    if (id !== null) {
      for (const t of await this.ctx.repos.trades.all({ mode: 'LIVE', walletId: id })) {
        if (isOpenStatus(t.status)) exposure += t.amount;
        if (t.status === 'SETTLED' && (t.claimStatus === 'UNCLAIMED' || t.claimStatus === 'CLAIMING'))
          claimable += t.payout ?? 0n;
        if (t.status === 'SETTLED' || t.status === 'FAILED') realized += tradeNetPnl(t) ?? 0n;
      }
    }
    const isSigner = id !== null && signer?.id === id;
    const balance = isSigner ? (this.liveBalance?.wei ?? null) : null;
    return {
      mode: 'LIVE',
      walletId: id,
      startingBankroll: balance === null ? null : balance + exposure + claimable - realized,
      bankrollBasis: balance === null ? 'NONE' : 'IMPLIED',
      balance,
      available: balance,
      exposure,
      claimable,
      realizedPnl: realized,
      balanceObservedAt: isSigner ? (this.liveBalance?.at ?? null) : null,
    };
  }

  async report(q: PortfolioQuery): Promise<{
    mode: PortfolioMode;
    account: AccountState | null;
    report: PortfolioReport;
    mixedModes: boolean;
  }> {
    const filter: TradeFilter = {
      mode: q.mode === 'ALL' ? undefined : q.mode,
      walletId: q.walletId,
      strategyId: q.strategyId,
      marketId: q.marketId,
      fromTime: q.fromMs,
      toTime: q.toMs,
    };
    const trades = await this.ctx.repos.trades.all(filter);
    const filtered = q.strategyId !== undefined || q.fromMs !== undefined || q.toMs !== undefined;
    const account =
      q.mode === 'PAPER'
        ? await this.paperAccount()
        : q.mode === 'LIVE'
          ? await this.liveAccount(q.walletId)
          : null;
    // A bankroll curve is only meaningful for the whole account; filtered views show P&L only.
    const start = filtered ? null : (account?.startingBankroll ?? null);
    const report = computePortfolio(await this.toEntries(trades), { startingBankroll: start });
    return {
      mode: q.mode,
      account,
      report: { ...report, equity: downsample(report.equity, EQUITY_POINTS) },
      mixedModes: q.mode === 'ALL',
    };
  }

  /** Records a portfolio snapshot per mode (balance curve, drawdown, win rate). */
  async snapshot(): Promise<void> {
    const { repos, reader, config } = this.ctx;
    const now = this.ctx.clock.nowMs();
    const take = async (acct: AccountState, trades: Trade[]) => {
      const s = computeSummary(await this.toEntries(trades), acct.startingBankroll);
      await repos.snapshots.insert({
        mode: acct.mode,
        walletId: acct.walletId,
        takenAt: now,
        balance: acct.balance ?? 0n,
        available: acct.available ?? 0n,
        deployed: acct.exposure,
        claimable: acct.claimable,
        realizedPnl: acct.realizedPnl,
        drawdown: s.maxDrawdown,
        roi: s.roi,
        winRate: s.winRate,
        lossRate: s.lossRate,
        trades: s.settledTrades,
      });
    };
    const paperTrades = await repos.trades.all({ mode: 'PAPER' });
    if (config.paperTradingEnabled || paperTrades.length > 0)
      await take(await this.paperAccount(), paperTrades);
    const signer = await repos.wallets.signer();
    if (signer && this.ctx.writer) {
      this.setLiveBalance(await reader.getBalance(signer.address as `0x${string}`));
      await take(
        await this.liveAccount(signer.id),
        await repos.trades.all({ mode: 'LIVE', walletId: signer.id }),
      );
    }
    this.ctx.bus.emit('portfolio', { takenAt: now });
  }
}
