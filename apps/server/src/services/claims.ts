/**
 * Claims (from bsc-predict-bot's claim loop): batches settled winning/refundable live trades and calls claim().
 * Claimability is verified on-chain first; rounds already claimed elsewhere (e.g. the PancakeSwap UI) are marked
 * CLAIMED without sending a transaction. Claim gas is attributed to the claimed trades.
 */
import { tradeNetPnl, weiToBnbString } from '@bsc/core';
import type { TxReceipt } from '../chain/types.js';
import { classifyError } from '../chain/types.js';
import type { Claim, Trade } from '../repositories/index.js';
import { errorMessage } from '../util/json.js';
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';
import { RECEIPT_TIMEOUT_MS } from './execution.js';

export class ClaimService {
  private running = false;

  constructor(private readonly ctx: Ctx) {}

  async run(
    opts: { force?: boolean } = {},
  ): Promise<{ claimedEpochs: number[]; skipped: string | null; claimId: number | null }> {
    const skip = (reason: string) => ({ claimedEpochs: [], skipped: reason, claimId: null });
    const { repos, config, writer, reader } = this.ctx;
    if (!writer) return skip('no signing wallet');
    if (!config.liveTradingEnabled) return skip('LIVE_TRADING_ENABLED is false');
    if (repos.bot.get().status === 'EMERGENCY_STOPPED') return skip('bot is emergency-stopped');
    if (this.running) return skip('a claim is already in progress');
    const wallet = repos.wallets.signer();
    const market = repos.markets.bySlug(config.marketSlug);
    if (!wallet || !market) return skip('no signer wallet / market');

    this.running = true;
    try {
      const unclaimed = repos.trades.unclaimed(wallet.id, market.id);
      if (unclaimed.length === 0) return skip('nothing to claim');
      const oldest = Math.min(...unclaimed.map((t) => t.settledAt ?? 0)) * 1000;
      if (
        !opts.force &&
        unclaimed.length < config.claimBatchMin &&
        this.ctx.clock.nowMs() - oldest < config.claimMaxDelayMs
      ) {
        return skip(`batching (${unclaimed.length}/${config.claimBatchMin})`);
      }

      const status = await reader.getClaimStatus(
        unclaimed.map((t) => t.epoch),
        writer.address,
      );
      const claimable = new Set(status.filter((s) => s.claimable || s.refundable).map((s) => s.epoch));
      for (const t of unclaimed) {
        if (claimable.has(t.epoch)) continue;
        const ledger = await reader.getLedger(t.epoch, writer.address);
        if (ledger.claimed)
          repos.trades.patch(t.id, { claimStatus: 'CLAIMED' }, 'already claimed on-chain (outside this app)');
        else
          this.ctx.log.tx.warn({ tradeId: t.id, epoch: t.epoch }, 'settled trade not claimable on-chain yet');
      }
      const toClaim = unclaimed.filter((t) => claimable.has(t.epoch));
      if (toClaim.length === 0) return skip('no on-chain claimable rounds');
      const epochs = toClaim.map((t) => t.epoch);

      const claim = repos.claims.insert({ walletId: wallet.id, marketId: market.id, epochs });
      let prepared;
      try {
        prepared = await writer.prepareClaim(epochs);
      } catch (err) {
        const e = classifyError(err);
        repos.claims.update(claim.id, { status: 'FAILED', error: e.message });
        this.auditFailure(claim, e.message);
        return { claimedEpochs: [], skipped: `claim simulation failed: ${e.message}`, claimId: claim.id };
      }
      repos.claims.update(claim.id, { txHash: prepared.hash, status: 'SUBMITTED' });
      for (const t of toClaim)
        repos.trades.patch(t.id, { claimStatus: 'CLAIMING', claimId: claim.id }, `claim tx ${prepared.hash}`);
      try {
        await writer.broadcast(prepared);
      } catch (err) {
        const e = classifyError(err);
        if (!e.maybeBroadcast) {
          this.revert(claim.id, toClaim, e.message);
          return { claimedEpochs: [], skipped: `broadcast failed: ${e.message}`, claimId: claim.id };
        }
      }
      const receipt = await writer.waitForReceipt(prepared.hash, RECEIPT_TIMEOUT_MS);
      if (!receipt)
        return { claimedEpochs: [], skipped: 'claim submitted; awaiting receipt', claimId: claim.id };
      const applied = this.applyReceipt(repos.claims.get(claim.id)!, receipt);
      return {
        claimedEpochs: applied ? epochs : [],
        skipped: applied ? null : 'claim reverted',
        claimId: claim.id,
      };
    } catch (err) {
      this.ctx.log.tx.error({ err }, 'claim run failed');
      return skip(`error: ${errorMessage(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** Applies a claim receipt; returns true when the claim succeeded. Also used by the reconciler. */
  applyReceipt(claim: Claim, receipt: TxReceipt): boolean {
    const { repos } = this.ctx;
    const trades = claim.epochs
      .map((e) => repos.trades.findLive(claim.walletId, claim.marketId, e))
      .filter((t): t is Trade => t !== undefined && t.claimId === claim.id);
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    this.attributeGas(trades, gasCost);
    if (receipt.status === 'success') {
      repos.claims.update(claim.id, { status: 'CONFIRMED', gasCost });
      for (const t of trades)
        repos.trades.patch(t.id, { claimStatus: 'CLAIMED' }, `claimed in block ${receipt.blockNumber}`);
      const total = trades.reduce((a, t) => a + (t.payout ?? 0n), 0n);
      this.ctx.audit.record({
        component: 'claims',
        severity: 'INFO',
        type: AuditType.PAYOUT_CLAIMED,
        marketId: claim.marketId,
        txHash: claim.txHash,
        message: `claimed ${weiToBnbString(total)} BNB for rounds ${claim.epochs.join(', ')} (gas ${weiToBnbString(gasCost)} BNB)`,
      });
      this.ctx.bus.emit('trade', { claimId: claim.id });
      return true;
    }
    repos.claims.update(claim.id, { status: 'FAILED', gasCost, error: 'claim reverted on-chain' });
    this.revert(claim.id, trades, 'claim reverted on-chain', false);
    return false;
  }

  /** Splits claim gas across trades (remainder to the first) and refreshes their net P&L. */
  private attributeGas(trades: Trade[], gasCost: bigint): void {
    if (trades.length === 0) return;
    const share = gasCost / BigInt(trades.length);
    const remainder = gasCost - share * BigInt(trades.length);
    trades.forEach((t, i) => {
      const claimGasCost = (t.claimGasCost ?? 0n) + share + (i === 0 ? remainder : 0n);
      const netPnl = tradeNetPnl({ ...t, claimGasCost });
      this.ctx.repos.trades.patch(
        t.id,
        { claimGasCost, netPnl },
        `claim gas share ${weiToBnbString(claimGasCost)} BNB`,
      );
    });
  }

  private revert(claimId: number, trades: Trade[], reason: string, updateClaim = true): void {
    if (updateClaim) this.ctx.repos.claims.update(claimId, { status: 'FAILED', error: reason });
    for (const t of trades)
      this.ctx.repos.trades.patch(
        t.id,
        { claimStatus: 'UNCLAIMED', claimId: null },
        `claim failed: ${reason}`,
      );
    this.auditFailure(this.ctx.repos.claims.get(claimId)!, reason);
  }

  private auditFailure(claim: Claim, reason: string): void {
    this.ctx.audit.record({
      component: 'claims',
      severity: 'ERROR',
      type: AuditType.CLAIM_FAILED,
      marketId: claim.marketId,
      txHash: claim.txHash,
      message: `claim for rounds ${claim.epochs.join(', ')} failed: ${reason}`,
    });
  }

  /** Called by the reconciler for claims left SUBMITTED. */
  async reconcileOpen(): Promise<void> {
    const { repos, reader } = this.ctx;
    for (const c of repos.claims.open()) {
      if (!c.txHash) {
        if (Date.parse(c.createdAt) < this.ctx.clock.nowMs() - 10 * 60_000)
          repos.claims.update(c.id, { status: 'FAILED', error: 'never submitted' });
        continue;
      }
      const receipt = await reader.getReceipt(c.txHash as `0x${string}`);
      if (receipt) this.applyReceipt(c, receipt);
      else if (Date.parse(c.updatedAt) < this.ctx.clock.nowMs() - 10 * 60_000) {
        const trades = c.epochs
          .map((e) => repos.trades.findLive(c.walletId, c.marketId, e))
          .filter((t): t is Trade => t !== undefined && t.claimId === c.id);
        this.revert(c.id, trades, 'claim transaction dropped (no receipt after 10 minutes)');
      }
    }
  }
}
