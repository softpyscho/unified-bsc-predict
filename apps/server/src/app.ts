/** Composition root: builds every service around one database, one event bus and one set of chain ports. */
import type { AppConfig } from './config.js';
import type { PredictionReader, PredictionWriter } from './chain/types.js';
import { createChainClient, ViemPredictionReader, ViemPredictionWriter } from './chain/viem.js';
import { Db } from './db/database.js';
import { migrate } from './db/migrations.js';
import type { Loggers } from './logger.js';
import { createLoggers } from './logger.js';
import { createRepos } from './repositories/index.js';
import { AuditLog } from './services/audit.js';
import { BacktestService } from './services/backtest.js';
import { BotController } from './services/bot.js';
import { ClaimService } from './services/claims.js';
import type { Clock, Ctx } from './services/context.js';
import { systemClock } from './services/context.js';
import { CsvImporter } from './services/csvImport.js';
import { StrategyEngine } from './services/engine.js';
import { EventBus } from './services/events.js';
import { ExecutionService } from './services/execution.js';
import { HistorySync } from './services/historySync.js';
import { MarketService } from './services/markets.js';
import { PoolEventCollector } from './services/poolEvents.js';
import { PortfolioService } from './services/portfolio.js';
import { RecoveryService } from './services/recovery.js';
import { ResearchService } from './services/research.js';
import { RiskStateBuilder } from './services/riskState.js';
import { RoundMonitor } from './services/roundMonitor.js';
import { SettlementService } from './services/settlement.js';
import { TxReconciler } from './services/txReconciler.js';
import { WalletSyncService } from './services/walletSync.js';
import { Worker } from './services/worker.js';

export interface AppDeps {
  reader?: PredictionReader;
  /** undefined = derive from config; null = no signer. */
  writer?: PredictionWriter | null;
  loggers?: Loggers;
  clock?: Clock;
}

export async function createApp(config: AppConfig, deps: AppDeps = {}) {
  const log = deps.loggers ?? createLoggers(config);
  const db = await Db.open(config.databaseUrl);
  await migrate(db);
  const repos = createRepos(db);
  const bus = new EventBus();
  const audit = new AuditLog(repos, bus, log.audit);

  let reader = deps.reader;
  let writer = deps.writer;
  if (!reader) {
    const viemReader = new ViemPredictionReader(
      createChainClient(config.rpcUrls, config.chainId),
      config.contractAddress,
      createChainClient(config.logRpcUrls, config.chainId),
    );
    reader = viemReader;
    if (writer === undefined && config.secrets.privateKey) {
      writer = new ViemPredictionWriter(viemReader, config.secrets.privateKey, config.chainId);
    }
  }
  const ctx: Ctx = {
    config,
    repos,
    log,
    bus,
    audit,
    reader,
    writer: writer ?? null,
    clock: deps.clock ?? systemClock,
  };

  const markets = new MarketService(ctx);
  await markets.seed();
  const bot = new BotController(ctx);
  const settlement = new SettlementService(ctx);
  const history = new HistorySync(ctx, markets, (rounds) => settlement.settleRounds(rounds));
  const monitor = new RoundMonitor(ctx, markets, history, (rounds) => settlement.settleRounds(rounds));
  const portfolio = new PortfolioService(ctx);
  const risk = new RiskStateBuilder(ctx, portfolio);
  const execution = new ExecutionService(ctx, bot);
  const engine = new StrategyEngine(ctx, { markets, bot, execution, risk, monitor });
  const claims = new ClaimService(ctx);
  const walletSync = new WalletSyncService(ctx, markets, history, settlement, execution);
  const txReconciler = new TxReconciler(ctx, execution, claims);
  const backtests = new BacktestService(ctx, markets);
  const csv = new CsvImporter(ctx);
  const poolEvents = new PoolEventCollector(ctx, markets);
  const research = new ResearchService(ctx, markets);
  await research.failInterrupted();
  const recovery = new RecoveryService(ctx, {
    bot,
    markets,
    history,
    walletSync,
    settlement,
    txReconciler,
    portfolio,
  });
  const worker = new Worker(ctx, {
    bot,
    monitor,
    engine,
    recovery,
    txReconciler,
    settlement,
    claims,
    walletSync,
    history,
    portfolio,
    poolEvents,
  });

  return {
    config,
    ctx,
    db,
    repos,
    bus,
    audit,
    log,
    markets,
    bot,
    settlement,
    history,
    monitor,
    portfolio,
    risk,
    execution,
    engine,
    claims,
    walletSync,
    txReconciler,
    backtests,
    csv,
    poolEvents,
    research,
    recovery,
    worker,
    async close(): Promise<void> {
      await worker.stop();
      await backtests.shutdown();
      await research.shutdown();
      await db.close();
      log.close();
    },
  };
}

export type App = Awaited<ReturnType<typeof createApp>>;
