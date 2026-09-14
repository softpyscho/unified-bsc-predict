/**
 * Trade monitor for wallets (replaces the per-account History view of bsc-prediction-market, which read
 * getUserRounds from the browser). Imports every on-chain bet of each registered wallet into the ledger
 * (source IMPORTED), confirms the bot's own trades from the contract ledger, and detects external claims.
 */
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';
import type { ExecutionService } from './execution.js';
import type { HistorySync } from './historySync.js';
import type { MarketService } from './markets.js';
import type { SettlementService } from './settlement.js';

const PAGE = 500;

export interface WalletSyncResult {
  walletId: number;
  total: number;
  cursor: number;
  imported: number;
  confirmed: number;
  claimedDetected: number;
}

export class WalletSyncService {
  constructor(
    private readonly ctx: Ctx,
    private readonly markets: MarketService,
    private readonly history: HistorySync,
    private readonly settlement: SettlementService,
    private readonly execution: ExecutionService,
  ) {}

  async syncAll(): Promise<WalletSyncResult[]> {
    const out: WalletSyncResult[] = [];
    for (const w of await this.ctx.repos.wallets.list()) if (w.enabled) out.push(await this.syncWallet(w.id));
    return out;
  }

  async syncWallet(walletId: number): Promise<WalletSyncResult> {
    const { repos, reader } = this.ctx;
    const wallet = await repos.wallets.get(walletId);
    if (!wallet) throw new Error(`wallet ${walletId} not found`);
    const market = this.markets.tradable();
    const address = wallet.address as `0x${string}`;
    const total = await reader.getUserRoundsLength(address);
    const res: WalletSyncResult = {
      walletId,
      total,
      cursor: wallet.userRoundsCursor,
      imported: 0,
      confirmed: 0,
      claimedDetected: 0,
    };
    const claimedOnChain: number[] = [];

    while (res.cursor < total) {
      const page = await reader.getUserRounds(address, res.cursor, PAGE);
      if (page.rounds.length === 0) break;
      const missing: number[] = [];
      for (const r of page.rounds) if (!(await repos.rounds.get(market.id, r.epoch))) missing.push(r.epoch);
      if (missing.length > 0) await this.history.syncEpochs(missing);

      let processed = 0;
      for (const ur of page.rounds) {
        const round = await repos.rounds.get(market.id, ur.epoch);
        if (!round) break; // retried on the next run
        const existing = await repos.trades.findLive(wallet.id, market.id, ur.epoch);
        if (existing) {
          const pending =
            existing.status === 'PENDING' ||
            existing.status === 'SUBMITTING' ||
            existing.status === 'SUBMITTED';
          if (pending && !this.execution.isInflight(existing.id)) {
            await this.execution.confirmFromLedger(existing.id, 'bet found on-chain via getUserRounds');
            res.confirmed++;
          }
          if (ur.amount !== existing.amount) {
            await this.ctx.audit.record({
              component: 'wallet-sync',
              severity: 'WARN',
              type: AuditType.TRADE_IMPORTED,
              epoch: ur.epoch,
              tradeId: existing.id,
              message: `on-chain bet amount ${ur.amount} differs from recorded amount ${existing.amount}`,
            });
          }
          if (ur.claimed && (existing.claimStatus === 'UNCLAIMED' || existing.claimStatus === 'CLAIMING')) {
            await repos.trades.patch(existing.id, { claimStatus: 'CLAIMED' }, 'claimed on-chain');
            res.claimedDetected++;
          } else if (ur.claimed) {
            claimedOnChain.push(existing.id);
          }
        } else {
          const t = await repos.trades.insert(
            {
              uid: `live:w${wallet.id}:${market.id}:${ur.epoch}`,
              mode: 'LIVE',
              source: 'IMPORTED',
              walletId: wallet.id,
              marketId: market.id,
              roundId: round.id,
              epoch: ur.epoch,
              strategyId: null,
              decisionId: null,
              direction: ur.position,
              amount: ur.amount,
              entryBullPayout: null,
              entryBearPayout: null,
              placedAt: (round.startTime ?? Math.floor(this.ctx.clock.nowMs() / 1000)) * 1000,
              status: 'CONFIRMED',
              gasCost: null,
            },
            'imported from contract ledger (getUserRounds); gas unknown',
          );
          if (ur.claimed) claimedOnChain.push(t.id);
          res.imported++;
        }
        processed++;
      }
      res.cursor += processed;
      await repos.wallets.setCursor(wallet.id, res.cursor);
      if (processed < page.rounds.length) break;
    }

    await this.settlement.settleAll();
    for (const id of claimedOnChain) {
      const t = await repos.trades.get(id);
      if (t && t.status === 'SETTLED' && t.claimStatus === 'UNCLAIMED') {
        await repos.trades.patch(id, { claimStatus: 'CLAIMED' }, 'claimed on-chain');
        res.claimedDetected++;
      }
    }
    if (res.imported > 0 || res.confirmed > 0) {
      await this.ctx.audit.record({
        component: 'wallet-sync',
        severity: 'INFO',
        type: AuditType.TRADE_IMPORTED,
        message: `wallet ${wallet.label} (${wallet.address}): ${res.imported} bets imported, ${res.confirmed} confirmed from ledger, ${res.claimedDetected} external claims`,
        metadata: { ...res },
      });
    }
    return res;
  }
}
