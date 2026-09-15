/**
 * Operator CLI. Uses the same services and database as the server. With a postgres:// DATABASE_URL, bot commands
 * take effect on a running server; embedded PGlite allows one process at a time, so stop the server first (or use
 * the dashboard).
 */
import { weiToBnbString } from '@bsc/core';
import { Command } from 'commander';
import fs from 'node:fs';
import { createApp } from './app.js';
import type { App } from './app.js';
import { ConfigError, loadConfig, publicConfig } from './config.js';
import type { AppConfig } from './config.js';
import { Db } from './db/database.js';
import { importSqlite } from './db/importSqlite.js';
import { migrate } from './db/migrations.js';
import { silentLoggers } from './logger.js';
import type { CsvFormat } from './services/csvImport.js';
import { sleep } from './util/async.js';
import { errorMessage, stringify } from './util/json.js';

const ARCHIVE = 'https://raw.githubusercontent.com/bsc-predict/bsc-predict-updater/master/data';
const DEFAULT_SOURCES: Record<CsvFormat, string> = {
  PANCAKESWAP_V2: `${ARCHIVE}/v2/main/rounds.csv`,
  PANCAKESWAP_V1: `${ARCHIVE}/main/rounds.csv`,
  PRDT: `${ARCHIVE}/prdt/rounds.csv`,
};
const FORMAT_ALIASES: Record<string, CsvFormat> = {
  v2: 'PANCAKESWAP_V2',
  v1: 'PANCAKESWAP_V1',
  prdt: 'PRDT',
};

function config(): AppConfig {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function withApp(fn: (app: App) => Promise<void> | void): Promise<void> {
  const app = await createApp(config(), { loggers: process.env.CLI_VERBOSE ? undefined : silentLoggers() });
  try {
    await fn(app);
  } catch (err) {
    console.error(`error: ${errorMessage(err)}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

const progress = (label: string) => {
  let last = 0;
  return (done: number, total: number) => {
    const now = Date.now();
    if (now - last > 1000 || done === total) {
      last = now;
      process.stdout.write(
        `\r${label}: ${done}/${total} (${total ? Math.floor((done / total) * 100) : 100}%)   `,
      );
      if (done === total) process.stdout.write('\n');
    }
  };
};

const print = (v: unknown) => console.log(JSON.stringify(JSON.parse(stringify(v)), null, 2));
const parseDate = (v: string) => {
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v) / 1000;
  if (!Number.isFinite(t)) throw new Error(`invalid date: ${v}`);
  return Math.floor(t);
};

const program = new Command().name('bsc-predict').description('Unified BSC prediction-market platform CLI');

program
  .command('migrate')
  .description('apply database migrations and seed markets/strategies')
  .action(() =>
    withApp((app) => {
      console.log(`database ready at ${app.config.databaseUrl.replace(/\/\/[^@/]+@/, '//***@')}`);
    }),
  );

program
  .command('import-sqlite <file>')
  .description(
    'one-time import of a legacy SQLite database (e.g. data/bsc-predict.db) into the configured, empty PostgreSQL database',
  )
  .action(async (file: string) => {
    const cfg = config();
    const db = await Db.open(cfg.databaseUrl);
    try {
      await migrate(db);
      const tables = new Map<string, ReturnType<typeof progress>>();
      const result = await importSqlite(db, file, (table, done, total) => {
        if (!tables.has(table)) tables.set(table, progress(`  ${table}`));
        tables.get(table)!(done, total);
      });
      print(result);
      console.log('Import complete. Start the server to seed any new strategies.');
    } catch (err) {
      console.error(`error: ${errorMessage(err)}`);
      process.exitCode = 1;
    } finally {
      await db.close();
    }
  });

program
  .command('import-history')
  .description('import bsc-predict-updater CSV archives (repeatable, duplicate-safe)')
  .option('--format <format>', 'v2 | v1 | prdt', 'v2')
  .option('--file <path>', 'local CSV file')
  .option('--url <url>', 'CSV URL (defaults to the bsc-predict-updater GitHub archive)')
  .option('--market <slug>', 'target market slug')
  .option('--all', 'import v2, v1 and prdt archives')
  .action((opts: { format: string; file?: string; url?: string; market?: string; all?: boolean }) =>
    withApp(async (app) => {
      const formats: CsvFormat[] = opts.all
        ? ['PANCAKESWAP_V2', 'PANCAKESWAP_V1', 'PRDT']
        : [FORMAT_ALIASES[opts.format.toLowerCase()] ?? (opts.format as CsvFormat)];
      for (const format of formats) {
        const source = (!opts.all && (opts.file ?? opts.url)) || DEFAULT_SOURCES[format];
        if (!source) throw new Error(`unknown format ${opts.format}`);
        console.log(`importing ${format} from ${source}`);
        const report = await app.csv.import({
          format,
          source,
          marketSlug: opts.all ? undefined : opts.market,
          onProgress: progress('  rounds'),
        });
        print(report);
      }
    }),
  );

program
  .command('sync-history')
  .description('initial/full synchronization: fetch every epoch not yet final in the database from chain')
  .option('--from <epoch>', 'first epoch', '1')
  .action((opts: { from: string }) =>
    withApp(async (app) => {
      print(await app.history.syncAll(Number(opts.from), progress('  epochs')));
    }),
  );

program
  .command('sync-current')
  .description('incremental synchronization of new and non-final rounds')
  .action(() =>
    withApp(async (app) => {
      print(await app.history.syncIncremental());
      const state = await app.monitor.tick();
      if (state)
        console.log(
          `current epoch ${state.currentEpoch}, next locks at ${new Date((state.next?.lockTime ?? 0) * 1000).toISOString()}`,
        );
    }),
  );

program
  .command('reconcile')
  .description('repair stale/missing rounds and verify stored rounds against chain')
  .action(() =>
    withApp(async (app) => {
      print(await app.history.reconcile());
      await app.txReconciler.run();
      await app.settlement.settleAll();
    }),
  );

const bot = program
  .command('bot')
  .description('control the bot (reaches a running server only with a postgres:// DATABASE_URL)');
bot.command('status').action(() => withApp(async (app) => print(await app.bot.view())));
bot
  .command('start')
  .option('--reason <text>')
  .action((o: { reason?: string }) => withApp(async (app) => print(await app.bot.start(o.reason ?? 'cli'))));
bot
  .command('stop')
  .option('--reason <text>')
  .action((o: { reason?: string }) => withApp(async (app) => print(await app.bot.stop(o.reason ?? 'cli'))));
bot
  .command('pause')
  .option('--reason <text>')
  .action((o: { reason?: string }) => withApp(async (app) => print(await app.bot.pause(o.reason ?? 'cli'))));
bot
  .command('resume')
  .option('--reason <text>')
  .action((o: { reason?: string }) => withApp(async (app) => print(await app.bot.resume(o.reason ?? 'cli'))));
bot
  .command('emergency-stop')
  .option('--reason <text>')
  .action((o: { reason?: string }) =>
    withApp(async (app) => print(await app.bot.emergencyStop(o.reason ?? 'cli'))),
  );
bot
  .command('reset')
  .description('clear an emergency stop')
  .option('--yes', 'acknowledge')
  .action((o: { yes?: boolean }) =>
    withApp(async (app) => print(await app.bot.resetEmergency(Boolean(o.yes)))),
  );

const strategy = program.command('strategy').description('manage strategies');
strategy.command('list').action(() =>
  withApp(async (app) => {
    for (const s of await app.repos.strategies.list()) {
      console.log(
        `${String(s.id).padStart(3)}  ${s.slug.padEnd(22)} enabled=${s.enabled} paper=${s.paperTradingEnabled} live=${s.liveTradingEnabled}  ${s.name}`,
      );
    }
  }),
);
strategy
  .command('enable <slug>')
  .option('--live', 'also enable live trading for this strategy (the global live gate still applies)')
  .action((slug: string, o: { live?: boolean }) =>
    withApp(async (app) => {
      const s = await app.repos.strategies.bySlug(slug);
      if (!s) throw new Error(`unknown strategy ${slug}`);
      print(
        await app.repos.strategies.setFlags(s.id, {
          enabled: true,
          ...(o.live ? { liveTradingEnabled: true } : {}),
        }),
      );
    }),
  );
strategy.command('disable <slug>').action((slug: string) =>
  withApp(async (app) => {
    const s = await app.repos.strategies.bySlug(slug);
    if (!s) throw new Error(`unknown strategy ${slug}`);
    print(await app.repos.strategies.setFlags(s.id, { enabled: false }));
  }),
);

program
  .command('backtest')
  .description('replay historical rounds through one or more strategies')
  .requiredOption('--strategy <slugs>', 'comma-separated strategy slugs')
  .requiredOption('--from <date>', 'ISO date or unix seconds')
  .requiredOption('--to <date>', 'ISO date or unix seconds')
  .option('--bankroll <bnb>', 'starting bankroll', '1')
  .option('--no-global-limits', 'do not apply the environment risk limits')
  .option(
    '--walk-forward <train:test[:step]>',
    'tune on rolling training windows and score each choice on the next, unseen window (in rounds), e.g. 20000:5000',
  )
  .option('--grid <json>', 'walk-forward parameter grid, e.g. \'{"streak":[2,3,4,5]}\'')
  .option('--anchored', 'walk-forward with an expanding training window')
  .option('--objective <objective>', 'walk-forward selection objective: netPnl | roi', 'netPnl')
  .option('--json', 'print the full result as JSON')
  .action(
    (o: {
      strategy: string;
      from: string;
      to: string;
      bankroll: string;
      globalLimits: boolean;
      walkForward?: string;
      grid?: string;
      anchored?: boolean;
      objective: string;
      json?: boolean;
    }) =>
      withApp(async (app) => {
        const strategies: { strategyId: number }[] = [];
        for (const slug of o.strategy.split(',')) {
          const s = await app.repos.strategies.bySlug(slug.trim());
          if (!s) throw new Error(`unknown strategy ${slug}`);
          strategies.push({ strategyId: s.id });
        }
        let walkForward: Record<string, unknown> | undefined;
        if (o.walkForward) {
          const [train, test, step] = o.walkForward.split(':').map(Number);
          walkForward = {
            trainRounds: train,
            testRounds: test,
            ...(step ? { stepRounds: step } : {}),
            anchored: Boolean(o.anchored),
            objective: o.objective,
            grid: o.grid ? (JSON.parse(o.grid) as unknown) : {},
          };
        }
        const id = await app.backtests.start({
          from: parseDate(o.from),
          to: parseDate(o.to),
          startingBankrollBnb: Number(o.bankroll),
          applyGlobalLimits: o.globalLimits,
          strategies,
          ...(walkForward ? { walkForward } : {}),
        });
        let run = (await app.repos.backtests.get(id))!;
        while (run.status === 'RUNNING') {
          process.stdout.write(`\rbacktest #${id}: ${Math.round(run.progress * 100)}%   `);
          await sleep(250);
          run = (await app.repos.backtests.get(id))!;
        }
        process.stdout.write('\n');
        if (run.status === 'FAILED') throw new Error(run.error ?? 'backtest failed');
        if (o.json) return print(run.result);
        const result = run.result as {
          rounds: number;
          results: { key: string; summary: Record<string, unknown>; decisions: Record<string, unknown> }[];
          walkForward?: {
            selectionStability: number | null;
            folds: {
              index: number;
              testFromEpoch: number;
              testToEpoch: number;
              chosen: Record<string, unknown>;
              test: { netPnl: string; settledTrades: number };
            }[];
          };
        };
        console.log(`rounds replayed: ${result.rounds}`);
        if (result.walkForward) {
          for (const f of result.walkForward.folds)
            console.log(
              `  fold ${String(f.index + 1).padStart(3)}  test ${f.testFromEpoch}-${f.testToEpoch}  chose ${JSON.stringify(f.chosen)}  ` +
                `trades=${f.test.settledTrades} net=${weiToBnbString(BigInt(f.test.netPnl), 6)} BNB`,
            );
          const st = result.walkForward.selectionStability;
          console.log(
            `  selection stability: ${st === null ? '-' : (st * 100).toFixed(0) + '%'} of folds kept the previous choice`,
          );
        }
        for (const r of result.results) {
          const s = r.summary as Record<string, string | number | null>;
          console.log(
            `${r.key.padEnd(24)} trades=${s.settledTrades} winRate=${s.winRate === null ? '-' : (Number(s.winRate) * 100).toFixed(2) + '%'} ` +
              `net=${weiToBnbString(BigInt(String(s.netPnl)), 6)} BNB roi=${s.roi === null ? '-' : (Number(s.roi) * 100).toFixed(2) + '%'} ` +
              `maxDD=${weiToBnbString(BigInt(String(s.maxDrawdown)), 6)} BNB`,
          );
        }
      }),
  );

program
  .command('wallet')
  .description('wallet utilities')
  .argument('<action>', 'sync | add')
  .argument('[address]', 'address for "add"')
  .option('--label <label>', 'label', 'Watched wallet')
  .action((action: string, address: string | undefined, o: { label: string }) =>
    withApp(async (app) => {
      if (action === 'add') {
        if (!address) throw new Error('address required');
        print(await app.repos.wallets.upsert(address, 'WATCH', o.label));
      } else if (action === 'sync') {
        print(await app.walletSync.syncAll());
      } else throw new Error(`unknown wallet action ${action}`);
    }),
  );

const pool = program
  .command('pool-events')
  .description('collect and verify per-bet pool events (BetBull/BetBear logs)');
pool
  .command('sync')
  .description(
    'collect new events and backfill older ones until caught up or the log node stops serving history',
  )
  .option('--backfill-chunks <n>', 'backfill chunks per pass', '20')
  .action((o: { backfillChunks: string }) =>
    withApp(async (app) => {
      for (let pass = 1; ; pass++) {
        const r = await app.poolEvents.run({ backfillChunks: Number(o.backfillChunks) });
        console.log(`pass ${pass}: ${stringify(r)}`);
        if (!r || r.caughtUp) break;
      }
      print(await app.poolEvents.status());
    }),
  );
pool.command('status').action(() => withApp(async (app) => print(await app.poolEvents.status())));
pool
  .command('reset-backfill')
  .description('retry backfill after it stopped (e.g. a different LOG_RPC_URLS with longer retention)')
  .action(() =>
    withApp(async (app) => {
      await app.poolEvents.resetBackfill();
      print(await app.poolEvents.status());
    }),
  );

const research = program
  .command('research')
  .description('pre-registered research experiments (stop the server first when using embedded PGlite)');
research
  .command('run')
  .description('register an experiment with a fixed specification, run it, and print the verdict')
  .requiredOption('--name <name>', 'experiment name')
  .option('--description <text>', 'what the experiment tests and why')
  .option('--families <list>', 'comma-separated: baseline,sequence,hour,pool')
  .option('--from-epoch <epoch>', 'first epoch')
  .option('--to-epoch <epoch>', 'last epoch')
  .option('--train <fraction>', 'chronological share used to form hypotheses')
  .option('--offsets <seconds>', 'decision offsets before lock, e.g. 30,10')
  .option('--stake <bnb>', 'stake per simulated bet')
  .action(
    (o: {
      name: string;
      description?: string;
      families?: string;
      fromEpoch?: string;
      toEpoch?: string;
      train?: string;
      offsets?: string;
      stake?: string;
    }) =>
      withApp(async (app) => {
        const list = (v: string) => v.split(',').map((s) => s.trim());
        const exp = await app.research.register({
          name: o.name,
          description: o.description,
          spec: {
            ...(o.families ? { families: list(o.families) } : {}),
            ...(o.fromEpoch ? { fromEpoch: Number(o.fromEpoch) } : {}),
            ...(o.toEpoch ? { toEpoch: Number(o.toEpoch) } : {}),
            ...(o.train ? { trainFraction: Number(o.train) } : {}),
            ...(o.offsets ? { decisionOffsets: list(o.offsets).map(Number) } : {}),
            ...(o.stake ? { stakeBnb: o.stake } : {}),
          },
        });
        console.log(`registered experiment #${exp.id}; running…`);
        const started = Date.now();
        const v = await app.research.run(exp.id);
        const r = v.result as { edges: { name: string }[]; breakEvenHitRate: number | null };
        console.log(
          `#${v.id} ${v.verdict} in ${((Date.now() - started) / 1000).toFixed(1)} s — ${stringify(v.dataSummary)}\n` +
            `  hypotheses: ${v.survivors}/${v.hypothesesTested} survive BH in this experiment, ` +
            `${v.globalSurvivors} across the whole ledger\n` +
            `  rules: ${v.edges}/${v.rulesSearched} edge candidates${r.edges.length ? `: ${r.edges.map((e) => e.name).join('; ')}` : ''}\n` +
            `  break-even hit rate: ${r.breakEvenHitRate === null ? '-' : (r.breakEvenHitRate * 100).toFixed(2) + '%'}`,
        );
      }),
  );
research.command('list').action(() =>
  withApp(async (app) => {
    for (const e of await app.research.list())
      console.log(
        `#${String(e.id).padStart(4)} ${e.status.padEnd(10)} ${String(e.verdict ?? '-').padEnd(14)} ` +
          `${e.survivors ?? '-'}/${e.hypothesesTested ?? '-'} hyp  ${e.edges ?? '-'}/${e.rulesSearched ?? '-'} rules  ${e.name}`,
      );
  }),
);
research
  .command('show <id>')
  .description('full stored result of one experiment')
  .action((id: string) =>
    withApp(async (app) => {
      const v = await app.research.view(Number(id));
      if (!v) throw new Error(`experiment ${id} not found`);
      print(v);
    }),
  );
research
  .command('ledger')
  .description('hypotheses significant after correcting across every test ever run')
  .action(() => withApp(async (app) => print(await app.research.ledger())));

program
  .command('health')
  .description('check configuration, database and chain connectivity')
  .action(() =>
    withApp(async (app) => {
      const checks: [string, () => Promise<unknown>][] = [
        ['config', async () => publicConfig(app.config)],
        [
          'database',
          async () =>
            Promise.all(
              (await app.repos.markets.list()).map(async (m) => ({
                slug: m.slug,
                ...(await app.repos.rounds.stats(m.id)),
              })),
            ),
        ],
        ['contract params', async () => app.markets.params(0)],
        ['chain head', async () => app.ctx.reader.getHead()],
        [
          'market snapshot',
          async () => {
            const s = await app.monitor.tick();
            return (
              s && {
                currentEpoch: s.currentEpoch,
                chainTime: s.chainTime,
                paused: s.paused,
                oracle: s.oracle,
                nextStatus: s.next?.status,
                liveStatus: s.live?.status,
              }
            );
          },
        ],
        [
          'wallet',
          async () => {
            if (!app.config.walletAddress) return 'no wallet configured';
            const bal = await app.ctx.reader.getBalance(app.config.walletAddress);
            return {
              address: app.config.walletAddress,
              balanceBnb: weiToBnbString(bal, 6),
              signer: app.config.hasSigner,
            };
          },
        ],
      ];
      let failed = 0;
      for (const [name, fn] of checks) {
        const started = Date.now();
        try {
          const res = await fn();
          console.log(`✔ ${name} (${Date.now() - started} ms)`);
          console.log(`  ${stringify(res).slice(0, 600)}`);
        } catch (err) {
          failed++;
          console.log(`✘ ${name}: ${errorMessage(err)}`);
        }
      }
      if (failed > 0) process.exitCode = 1;
    }),
  );

program
  .command('verify-chain')
  .description(
    'read-only checks of every contract call used, plus dry-run bet construction with a throwaway key (never broadcasts)',
  )
  .action(() =>
    withApp(async (app) => {
      const { generatePrivateKey } = await import('viem/accounts');
      const { createChainClient, ViemPredictionReader, ViemPredictionWriter } =
        await import('./chain/viem.js');
      const { classifyError } = await import('./chain/types.js');
      const reader = new ViemPredictionReader(
        createChainClient(app.config.rpcUrls, app.config.chainId),
        app.config.contractAddress,
      );
      const writer = new ViemPredictionWriter(reader, generatePrivateKey(), app.config.chainId);
      const params = await reader.getParams();
      const head = await reader.getHead();
      const snap = await reader.getSnapshot();
      const epochs = [head.currentEpoch - 3, head.currentEpoch - 2];
      const steps: [string, () => Promise<unknown>][] = [
        ['params', async () => params],
        ['head', async () => head],
        [
          'snapshot',
          async () => ({ epoch: snap.currentEpoch, next: snap.rounds[0]?.startTime, oracle: snap.oracle }),
        ],
        [
          'rounds (multicall, pinned block)',
          async () =>
            (await reader.getRounds(epochs, head.blockNumber - 3n)).map((r) => ({
              epoch: r.epoch,
              oracleCalled: r.oracleCalled,
            })),
        ],
        ['ledger (throwaway wallet)', async () => reader.getLedger(head.currentEpoch, writer.address)],
        ['getUserRoundsLength (throwaway wallet)', async () => reader.getUserRoundsLength(writer.address)],
        ['getUserRounds (throwaway wallet)', async () => reader.getUserRounds(writer.address, 0, 10)],
        ['claimable/refundable', async () => reader.getClaimStatus(epochs, writer.address)],
        ['balance (throwaway wallet)', async () => reader.getBalance(writer.address)],
        ['gas price', async () => reader.getGasPrice()],
        [
          'betBull dry-run, value 0 (expect contract revert)',
          async () => {
            try {
              await writer.prepareBet('BULL', head.currentEpoch, 0n);
              return 'UNEXPECTED: simulation succeeded';
            } catch (err) {
              const e = classifyError(err);
              return `${e.errorClass}: ${e.message}`;
            }
          },
        ],
        [
          'betBull dry-run, value = minBetAmount (expect insufficient funds)',
          async () => {
            try {
              await writer.prepareBet('BULL', head.currentEpoch, params.minBetWei);
              return 'UNEXPECTED: simulation succeeded';
            } catch (err) {
              const e = classifyError(err);
              return `${e.errorClass}: ${e.message}`;
            }
          },
        ],
      ];
      for (const [name, fn] of steps) {
        try {
          console.log(`✔ ${name}: ${stringify(await fn()).slice(0, 300)}`);
        } catch (err) {
          process.exitCode = 1;
          console.log(`✘ ${name}: ${errorMessage(err).slice(0, 300)}`);
        }
      }
      console.log('No transaction was broadcast.');
    }),
  );

program
  .command('serve')
  .description('start the server (same as npm start)')
  .action(async () => {
    await import('./main.js');
  });

program.parseAsync().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exit(1);
});
