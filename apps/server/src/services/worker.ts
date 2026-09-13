/** Schedules the background loops. Each loop is sequential (no overlapping runs) and isolated from the others. */
import { sleep } from '../util/async.js';
import type { BotController } from './bot.js';
import type { ClaimService } from './claims.js';
import type { Ctx } from './context.js';
import type { StrategyEngine } from './engine.js';
import type { HistorySync } from './historySync.js';
import type { PortfolioService } from './portfolio.js';
import type { RecoveryService } from './recovery.js';
import type { RoundMonitor } from './roundMonitor.js';
import type { SettlementService } from './settlement.js';
import type { TxReconciler } from './txReconciler.js';
import type { WalletSyncService } from './walletSync.js';

const RECOVERY_RETRY_MS = 15_000;

export class Worker {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private loopsStarted = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly deps: {
      bot: BotController;
      monitor: RoundMonitor;
      engine: StrategyEngine;
      recovery: RecoveryService;
      txReconciler: TxReconciler;
      settlement: SettlementService;
      claims: ClaimService;
      walletSync: WalletSyncService;
      history: HistorySync;
      portfolio: PortfolioService;
    },
  ) {}

  /** Starts market monitoring immediately (dashboard data) and trading loops once recovery succeeds. */
  start(): void {
    const { config } = this.ctx;
    const { monitor, engine } = this.deps;
    this.every(
      'monitor',
      config.pollIntervalMs,
      async () => {
        const state = await monitor.tick();
        if (state) await engine.onMarketState(state);
      },
      0,
    );
    void this.recover();
  }

  private async recover(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.track(this.deps.recovery.run());
        break;
      } catch (err) {
        this.ctx.log.app.error({ err }, 'recovery failed; retrying');
        await sleep(RECOVERY_RETRY_MS);
      }
    }
    if (!this.stopped) this.startLoops();
  }

  private startLoops(): void {
    if (this.loopsStarted) return;
    this.loopsStarted = true;
    const { config } = this.ctx;
    const d = this.deps;
    this.every('tx-reconciler', 15_000, () => d.txReconciler.run());
    this.every('settlement', 30_000, () => d.settlement.settleAll());
    this.every('claims', 60_000, async () => (d.bot.canTrade() ? d.claims.run() : null));
    this.every('wallet-sync', config.walletSyncIntervalMs, () => d.walletSync.syncAll());
    this.every('history-incremental', 5 * 60_000, () => d.history.syncIncremental());
    this.every('reconcile', config.reconcileIntervalMs, () => d.history.reconcile());
    this.every('snapshot', 5 * 60_000, () => d.portfolio.snapshot());
  }

  get loopsRunning(): boolean {
    return this.loopsStarted;
  }

  private every(name: string, ms: number, fn: () => Promise<unknown> | unknown, firstDelay = ms): void {
    const run = async () => {
      if (this.stopped) return;
      try {
        await this.track(Promise.resolve(fn()));
      } catch (err) {
        this.ctx.log.app.error({ err, loop: name }, 'background loop failed');
      } finally {
        if (!this.stopped)
          this.timers.set(
            name,
            setTimeout(() => void run(), ms),
          );
      }
    };
    this.timers.set(
      name,
      setTimeout(() => void run(), firstDelay),
    );
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.active.add(p);
    void p.finally(() => this.active.delete(p)).catch(() => undefined);
    return p;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled([...this.active]);
  }
}
