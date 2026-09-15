/**
 * Schedules the background loops. Each loop is sequential (no overlapping runs) and isolated from the others.
 *
 * Only one worker may be active per database: the loops run only while this process holds the database's worker
 * lease (see Db.tryAcquireWorkerLease). Another copy of the server (a PC and a cloud VM, say) serves its API but
 * stands by, and takes over if the active worker stops or loses its database connection.
 */
import { sleep } from '../util/async.js';
import type { BotController } from './bot.js';
import type { ClaimService } from './claims.js';
import type { Ctx } from './context.js';
import type { StrategyEngine } from './engine.js';
import type { HistorySync } from './historySync.js';
import type { PoolEventCollector } from './poolEvents.js';
import type { PortfolioService } from './portfolio.js';
import type { RecoveryService } from './recovery.js';
import type { RoundMonitor } from './roundMonitor.js';
import type { SettlementService } from './settlement.js';
import type { TxReconciler } from './txReconciler.js';
import type { WalletSyncService } from './walletSync.js';

const RECOVERY_RETRY_MS = 15_000;
const POOL_EVENTS_INTERVAL_MS = 15_000;
const POOL_EVENTS_BACKFILL_CHUNKS_PER_RUN = 4;
/** How often the lease is re-checked (and, on standby, re-tried). */
const LEASE_CHECK_MS = 15_000;

export class Worker {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private loopsStarted = false;
  private leased = false;
  /** Bumped whenever work stops, so loops scheduled under an earlier lease end on their own. */
  private generation = 0;
  private wake: (() => void) | null = null;

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
      poolEvents: PoolEventCollector;
    },
    private readonly opts: { leaseCheckMs?: number } = {},
  ) {}

  /** Becomes the active worker as soon as the database's worker lease is free. */
  start(): void {
    void this.leaseLoop();
  }

  get leaseHeld(): boolean {
    return this.leased;
  }

  get loopsRunning(): boolean {
    return this.loopsStarted;
  }

  private async leaseLoop(): Promise<void> {
    const db = this.ctx.repos.db;
    let announcedStandby = false;
    while (!this.stopped) {
      try {
        if (!this.leased) {
          if (await db.tryAcquireWorkerLease()) {
            if (this.stopped) break;
            this.leased = true;
            announcedStandby = false;
            this.ctx.log.app.info('worker lease acquired: this process is the active worker');
            this.startWork();
          } else if (!announcedStandby) {
            announcedStandby = true;
            this.ctx.log.app.warn(
              "another worker holds this database's worker lease; standing by (API only) until it is free",
            );
          }
        } else if (!(await db.checkWorkerLease())) {
          this.ctx.log.app.error('worker lease lost; stopping the loops until it can be taken again');
          this.leased = false;
          await this.stopWork();
        }
      } catch (err) {
        this.ctx.log.app.error({ err }, 'worker lease check failed');
      }
      await this.pause(this.opts.leaseCheckMs ?? LEASE_CHECK_MS);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  private live(gen: number): boolean {
    return !this.stopped && gen === this.generation;
  }

  /** Market monitoring and data collection start at once; trading loops once recovery succeeds. */
  private startWork(): void {
    const gen = this.generation;
    const { config } = this.ctx;
    const { monitor, engine } = this.deps;
    this.every(
      gen,
      'monitor',
      config.pollIntervalMs,
      async () => {
        const state = await monitor.tick();
        if (state) await engine.onMarketState(state);
      },
      0,
    );
    // Research data collection is independent of trading recovery.
    if (config.poolEvents.enabled)
      this.every(
        gen,
        'pool-events',
        POOL_EVENTS_INTERVAL_MS,
        () => this.deps.poolEvents.run({ backfillChunks: POOL_EVENTS_BACKFILL_CHUNKS_PER_RUN }),
        5_000,
      );
    void this.recover(gen);
  }

  private async recover(gen: number): Promise<void> {
    while (this.live(gen)) {
      try {
        await this.track(this.deps.recovery.run());
        break;
      } catch (err) {
        this.ctx.log.app.error({ err }, 'recovery failed; retrying');
        await sleep(RECOVERY_RETRY_MS);
      }
    }
    if (this.live(gen)) this.startLoops(gen);
  }

  private startLoops(gen: number): void {
    if (this.loopsStarted) return;
    this.loopsStarted = true;
    const { config } = this.ctx;
    const d = this.deps;
    this.every(gen, 'tx-reconciler', 15_000, () => d.txReconciler.run());
    this.every(gen, 'settlement', 30_000, () => d.settlement.settleAll());
    this.every(gen, 'claims', 60_000, async () => ((await d.bot.canTrade()) ? d.claims.run() : null));
    this.every(gen, 'wallet-sync', config.walletSyncIntervalMs, () => d.walletSync.syncAll());
    this.every(gen, 'history-incremental', 5 * 60_000, () => d.history.syncIncremental());
    this.every(gen, 'reconcile', config.reconcileIntervalMs, () => d.history.reconcile());
    this.every(gen, 'snapshot', 5 * 60_000, () => d.portfolio.snapshot());
  }

  private async stopWork(): Promise<void> {
    this.generation++;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.loopsStarted = false;
    await Promise.allSettled([...this.active]);
  }

  private every(
    gen: number,
    name: string,
    ms: number,
    fn: () => Promise<unknown> | unknown,
    firstDelay = ms,
  ): void {
    const run = async () => {
      if (!this.live(gen)) return;
      try {
        await this.track(Promise.resolve(fn()));
      } catch (err) {
        this.ctx.log.app.error({ err, loop: name }, 'background loop failed');
      } finally {
        if (this.live(gen))
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
    this.wake?.();
    await this.stopWork();
    if (this.leased) {
      this.leased = false;
      await this.ctx.repos.db.releaseWorkerLease().catch(() => undefined);
    }
  }
}
