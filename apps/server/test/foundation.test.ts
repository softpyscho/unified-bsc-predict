import { bnbToWei } from '@bsc/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, publicConfig } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { importSqlite } from '../src/db/importSqlite.js';
import { migrate } from '../src/db/migrations.js';
import { createLoggers } from '../src/logger.js';
import { createRepos } from '../src/repositories/index.js';
import { testEnv } from './harness.js';

describe('configuration', () => {
  it('fails clearly when required settings are missing or unsafe', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ LIVE_TRADING_ENABLED: 'true', ADMIN_API_TOKEN: 'short', MAX_BET_SIZE: 'abc' });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/ADMIN_API_TOKEN/);
      expect(msg).toMatch(/MAX_BET_SIZE/);
    }
    expect(() => loadConfig(testEnv({ LIVE_TRADING_ENABLED: 'true' }))).toThrow(/requires PRIVATE_KEY/);
    expect(() => loadConfig(testEnv({ ADMIN_API_TOKEN: 'REPLACE-ME-REPLACE-ME-REPLACE-ME' }))).toThrow(
      /placeholder/,
    );
    expect(() => loadConfig(testEnv({ DATABASE_URL: 'file:./data/bsc-predict.db' }))).toThrow(
      /import-sqlite/,
    );
  });

  it('defaults to paper trading with live disabled', () => {
    const c = loadConfig(testEnv());
    expect(c.liveTradingEnabled).toBe(false);
    expect(c.paperTradingEnabled).toBe(true);
    expect(c.hasSigner).toBe(false);
  });

  it('derives and verifies the wallet address from the key', () => {
    const key = generatePrivateKey();
    const addr = privateKeyToAccount(key).address;
    expect(loadConfig(testEnv({ PRIVATE_KEY: key })).walletAddress).toBe(addr);
    expect(() =>
      loadConfig(testEnv({ PRIVATE_KEY: key, WALLET_ADDRESS: '0x1111111111111111111111111111111111111111' })),
    ).toThrow(/does not match/);
  });

  it('never exposes secrets through serialization', () => {
    const key = generatePrivateKey();
    const c = loadConfig(testEnv({ PRIVATE_KEY: key }));
    expect(c.secrets.privateKey).toBe(key);
    const json = JSON.stringify(c, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json).not.toContain(key.slice(2));
    expect(json).not.toContain(c.secrets.adminToken);
    expect(
      JSON.stringify(publicConfig(c), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain(key.slice(2));
  });
});

describe('logger', () => {
  it('scrubs the private key and admin token from every channel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-log-'));
    const key = generatePrivateKey();
    const config = loadConfig(testEnv({ PRIVATE_KEY: key, LOG_DIR: dir, LOG_LEVEL: 'info' }));
    const log = createLoggers(config);
    log.app.info(
      { privateKey: key, nested: { note: `leak ${key}` } },
      `message with ${key.slice(2)} and ${config.secrets.adminToken}`,
    );
    log.tx.error({ err: new Error(`boom ${key}`) }, 'failure');
    await new Promise((r) => setTimeout(r, 200));
    log.close();
    const content = ['app.log', 'tx.log', 'error.log']
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain(key.slice(2));
    expect(content).not.toContain(config.secrets.adminToken);
    expect(fs.readFileSync(path.join(dir, 'error.log'), 'utf8')).toContain('failure');
  });
});

describe('database integrity', () => {
  const setup = async () => {
    const db = await Db.open('memory:');
    await migrate(db);
    const repos = createRepos(db);
    const market = await repos.markets.upsert({
      slug: 'm',
      name: 'm',
      symbol: 'BNBUSD',
      underlyingAsset: 'BNB',
      quoteAsset: 'USD',
      chain: 'bsc',
      chainId: 56,
      contractAddress: '0x0000000000000000000000000000000000000001',
      protocol: 'PANCAKESWAP_V2',
      timing: 'TIMESTAMP',
      tradable: true,
      active: true,
      intervalSeconds: 300,
      bufferSeconds: 30,
      treasuryFeeBps: 300,
      minBetWei: null,
      oracleAddress: null,
      description: null,
    });
    return { db, repos, market };
  };
  const record = (epoch: number, over: Record<string, unknown> = {}) => ({
    epoch,
    startTime: 1000 + epoch * 300,
    lockTime: 1300 + epoch * 300,
    closeTime: 1600 + epoch * 300,
    lockPrice: 100,
    closePrice: 200,
    lockOracleId: '1',
    closeOracleId: '2',
    totalAmount: 3n,
    bullAmount: 1n,
    bearAmount: 2n,
    rewardBaseCalAmount: 1n,
    rewardAmount: 2n,
    oracleCalled: true,
    ...over,
  });
  const write = (source: 'CHAIN' | 'CSV_IMPORT', rec = record(1)) => ({
    record: rec,
    status: 'ENDED' as const,
    outcome: 'BULL' as const,
    isFinal: true,
    source,
    treasuryFeeBps: 300,
  });

  it('migrations are idempotent', async () => {
    const { db } = await setup();
    expect(await migrate(db)).toEqual([]);
    await db.close();
  });

  it('upserts rounds idempotently on (market, epoch)', async () => {
    const { db, repos, market } = await setup();
    expect((await repos.rounds.upsert(market.id, write('CHAIN'))).result).toBe('inserted');
    expect((await repos.rounds.upsert(market.id, write('CHAIN'))).result).toBe('unchanged');
    expect((await repos.rounds.stats(market.id)).total).toBe(1);
    await db.close();
  });

  it('never overwrites final chain data; CSV rows can be corrected by chain data with history kept', async () => {
    const { db, repos, market } = await setup();
    await repos.rounds.upsert(market.id, write('CHAIN'));
    expect((await repos.rounds.upsert(market.id, write('CHAIN', record(1, { closePrice: 50 })))).result).toBe(
      'conflict',
    );
    expect((await repos.rounds.get(market.id, 1))!.closePrice).toBe(200);
    await expect(db.run('UPDATE rounds SET close_price = 1 WHERE epoch = 1')).rejects.toThrow(/immutable/);

    await repos.rounds.upsert(market.id, write('CSV_IMPORT', record(2, { closePrice: 50 })));
    const res = await repos.rounds.upsert(market.id, write('CHAIN', record(2)));
    expect(res.result).toBe('corrected');
    expect((await repos.rounds.get(market.id, 2))!.closePrice).toBe(200);
    expect(await repos.rounds.corrections(res.round.id)).toHaveLength(1);
    await db.close();
  });

  it('keeps the audit log and trade events append-only', async () => {
    const { db, repos } = await setup();
    await repos.audit.append({ component: 't', severity: 'INFO', type: 'X', message: 'm' });
    await expect(db.run('UPDATE audit_events SET message = ?', ['x'])).rejects.toThrow(/append-only/);
    await expect(db.run('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    await db.close();
  });

  it('guards trade transitions and allows only one live bet per wallet and round', async () => {
    const { db, repos, market } = await setup();
    const round = (await repos.rounds.upsert(market.id, write('CHAIN'))).round;
    const wallet = await repos.wallets.upsert('0x3333333333333333333333333333333333333333', 'SIGNER', 'w');
    const base = {
      mode: 'LIVE' as const,
      source: 'BOT' as const,
      walletId: wallet.id,
      marketId: market.id,
      roundId: round.id,
      epoch: 1,
      strategyId: null,
      decisionId: null,
      direction: 'BULL' as const,
      amount: bnbToWei('0.01'),
      entryBullPayout: null,
      entryBearPayout: null,
      placedAt: 1,
      status: 'PENDING' as const,
    };
    const t = await repos.trades.insert({ ...base, uid: 'a' }, 'created');
    await expect(repos.trades.insert({ ...base, uid: 'b' }, 'dup')).rejects.toThrow(/unique constraint/);
    await expect(repos.trades.transition(t.id, 'PENDING', 'SETTLED', {}, 'x')).rejects.toThrow(/Illegal/);
    await repos.trades.transition(t.id, 'PENDING', 'SUBMITTING', { txHash: '0xabc' }, 'signed');
    await expect(repos.trades.transition(t.id, 'PENDING', 'SUBMITTING', {}, 'again')).rejects.toThrow(
      /no longer/,
    );
    await repos.trades.transition(t.id, 'SUBMITTING', 'FAILED', { error: 'x' }, 'failed');
    // A failed bet frees the slot (the contract never recorded it).
    expect((await repos.trades.insert({ ...base, uid: 'c' }, 'retry')).status).toBe('PENDING');
    expect((await repos.trades.events(t.id)).map((e) => e.toStatus)).toEqual([
      'PENDING',
      'SUBMITTING',
      'FAILED',
    ]);
    await expect(db.run('DELETE FROM trade_events')).rejects.toThrow(/append-only/);
    await db.close();
  });
});

describe('legacy SQLite import', () => {
  it('copies rows with their ids, restores bot state and advances identity sequences', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-sqlite-')), 'legacy.db');
    const src = new DatabaseSync(file);
    src.exec(`
      CREATE TABLE markets (id INTEGER PRIMARY KEY, slug TEXT, name TEXT, symbol TEXT, underlying_asset TEXT,
        quote_asset TEXT, chain TEXT, chain_id INTEGER, contract_address TEXT, protocol TEXT, timing TEXT,
        tradable INTEGER, active INTEGER, interval_seconds INTEGER, buffer_seconds INTEGER, treasury_fee_bps INTEGER,
        created_at TEXT, updated_at TEXT, legacy_only_column TEXT);
      CREATE TABLE audit_events (id INTEGER PRIMARY KEY, ts INTEGER, component TEXT, severity TEXT, type TEXT,
        message TEXT);
      CREATE TABLE bot_state (id INTEGER PRIMARY KEY, status TEXT, status_reason TEXT, live_armed INTEGER,
        live_armed_at TEXT, consecutive_failures INTEGER, updated_at TEXT);
    `);
    const now = new Date().toISOString();
    src
      .prepare(
        `INSERT INTO markets VALUES (7, 'legacy', 'Legacy', 'BNBUSD', 'BNB', 'USD', 'bsc', 56,
          '0x0000000000000000000000000000000000000007', 'PANCAKESWAP_V2', 'TIMESTAMP', 0, 1, 300, 30, 300, ?, ?, 'x')`,
      )
      .run(now, now);
    const insertAudit = src.prepare("INSERT INTO audit_events VALUES (?, ?, 'import', 'INFO', 'LEGACY', ?)");
    for (let i = 1; i <= 1_234; i++) insertAudit.run(i * 2, i, `event ${i}`);
    src.prepare("INSERT INTO bot_state VALUES (1, 'PAUSED', 'legacy pause', 0, NULL, 3, ?)").run(now);
    src.close();

    const db = await Db.open('memory:');
    await migrate(db);
    const progress: string[] = [];
    const res = await importSqlite(db, file, (table) => progress.push(table));
    expect(res.find((r) => r.table === 'markets')!.rows).toBe(1);
    expect(res.find((r) => r.table === 'audit_events')!.rows).toBe(1_234);
    expect(res.find((r) => r.table === 'trades')!.rows).toBe(0); // absent in the source
    expect(progress).toContain('audit_events');

    const repos = createRepos(db);
    expect((await repos.markets.get(7))!.slug).toBe('legacy');
    expect((await db.get<{ id: number }>('SELECT max(id) AS id FROM audit_events'))!.id).toBe(2_468);
    const bot = await repos.bot.get();
    expect(bot.status).toBe('PAUSED');
    expect(bot.consecutiveFailures).toBe(3);
    // New rows continue after the imported ids instead of colliding with them.
    const next = await repos.audit.append({ component: 't', severity: 'INFO', type: 'X', message: 'new' });
    expect(next.id).toBeGreaterThan(2_468);
    await expect(importSqlite(db, file)).rejects.toThrow(/already contains data/);
    await db.close();
  });
});
