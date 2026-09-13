/**
 * Restart recovery. Runs before any execution is allowed (bot phase RECOVERING):
 *   1. contract parameters   2. pending transactions   3. history sync + non-final rounds
 *   4. wallet trades         5. settlements            6. portfolio snapshot
 * Only then does the bot become READY. A previously armed live mode is disarmed unless BOT_AUTO_RESUME_LIVE=true,
 * so a crash can never silently resume real-money trading.
 */
import { errorMessage } from '../util/json.js';
import { AuditType } from './audit.js';
import type { BotController } from './bot.js';
import type { Ctx } from './context.js';
import type { HistorySync } from './historySync.js';
import type { MarketService } from './markets.js';
import type { PortfolioService } from './portfolio.js';
import type { SettlementService } from './settlement.js';
import type { TxReconciler } from './txReconciler.js';
import type { WalletSyncService } from './walletSync.js';

export class RecoveryService {
  constructor(
    private readonly ctx: Ctx,
    private readonly deps: {
      bot: BotController;
      markets: MarketService;
      history: HistorySync;
      walletSync: WalletSyncService;
      settlement: SettlementService;
      txReconciler: TxReconciler;
      portfolio: PortfolioService;
    },
  ) {}

  async run(): Promise<Record<string, unknown>> {
    const { bot, markets, history, walletSync, settlement, txReconciler, portfolio } = this.deps;
    bot.setPhase('RECOVERING');
    this.ctx.audit.record({
      component: 'recovery',
      severity: 'INFO',
      type: AuditType.RECOVERY_STARTED,
      message: 'startup recovery started',
    });
    const interrupted = this.ctx.repos.backtests.failInterrupted();
    const results: Record<string, unknown> = { interruptedBacktests: interrupted };
    const steps: [string, () => Promise<unknown> | unknown][] = [
      ['contractParams', () => markets.params(0)],
      ['pendingTransactions', () => txReconciler.run()],
      // Recent window + every non-final stored round (which includes the rounds of all open trades).
      ['historySync', () => history.syncIncremental({ maxEpochs: 2_000 })],
      ['walletTrades', () => walletSync.syncAll()],
      ['settlements', () => settlement.settleAll()],
      ['portfolioSnapshot', () => portfolio.snapshot()],
    ];
    for (const [name, step] of steps) {
      try {
        results[name] = await step();
      } catch (err) {
        this.ctx.audit.record({
          component: 'recovery',
          severity: 'ERROR',
          type: AuditType.RECOVERY_FAILED,
          message: `recovery step "${name}" failed: ${errorMessage(err)}; trading stays blocked, retrying`,
        });
        throw err;
      }
    }
    const state = this.ctx.repos.bot.get();
    if (state.liveArmed && !this.ctx.config.botAutoResumeLive) {
      bot.disarmLive(
        'process restarted; re-arm live trading from the dashboard (BOT_AUTO_RESUME_LIVE=false)',
      );
    }
    bot.setPhase('READY');
    this.ctx.audit.record({
      component: 'recovery',
      severity: 'INFO',
      type: AuditType.RECOVERY_COMPLETED,
      message: `startup recovery completed; bot status ${state.status}`,
      metadata: JSON.parse(
        JSON.stringify(results, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ) as Record<string, unknown>,
    });
    return results;
  }
}
