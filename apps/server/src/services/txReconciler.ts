/**
 * Resolves live trades whose outcome is unknown (crash mid-submission, RPC timeout, dropped tx). Never re-sends:
 * the receipt or the contract ledger decides whether the bet exists.
 */
import type { Ctx } from './context.js';
import type { ClaimService } from './claims.js';
import type { ExecutionService } from './execution.js';

const PENDING_GRACE_MS = 30_000;

export class TxReconciler {
  constructor(
    private readonly ctx: Ctx,
    private readonly execution: ExecutionService,
    private readonly claims: ClaimService,
  ) {}

  async run(): Promise<{ checked: number; confirmed: number; failed: number }> {
    const { repos, reader, clock } = this.ctx;
    const out = { checked: 0, confirmed: 0, failed: 0 };
    const open = repos.trades.byStatus(['PENDING', 'SUBMITTING', 'SUBMITTED'], 'LIVE');
    let head: Awaited<ReturnType<typeof reader.getHead>> | null = null;

    for (const t of open) {
      if (this.execution.isInflight(t.id)) continue;
      out.checked++;
      if (t.status === 'PENDING' || !t.txHash) {
        if (clock.nowMs() - t.placedAt > PENDING_GRACE_MS) {
          this.execution.fail(
            t.id,
            'INTERRUPTED',
            'process stopped before the transaction was signed',
            false,
          );
          out.failed++;
        }
        continue;
      }
      const receipt = await reader.getReceipt(t.txHash as `0x${string}`);
      if (receipt) {
        const after = this.execution.applyReceipt(t.id, receipt);
        if (after.status === 'CONFIRMED') out.confirmed++;
        else out.failed++;
        continue;
      }
      const round = repos.rounds.getById(t.roundId);
      const wallet = t.walletId === null ? undefined : repos.wallets.get(t.walletId);
      if (!round || !wallet) continue;
      head ??= await reader.getHead();
      const buffer = repos.markets.get(t.marketId)?.bufferSeconds ?? 30;
      if (round.lockTime !== null && head.blockTimestamp > round.lockTime + buffer) {
        const ledger = await reader.getLedger(t.epoch, wallet.address as `0x${string}`);
        if (ledger.amount > 0n) {
          this.execution.confirmFromLedger(t.id, 'bet found in contract ledger; receipt unavailable');
          out.confirmed++;
        } else {
          this.execution.fail(t.id, 'DROPPED', 'transaction was not mined before the round locked', true);
          out.failed++;
        }
      }
    }
    await this.claims.reconcileOpen();
    return out;
  }
}
