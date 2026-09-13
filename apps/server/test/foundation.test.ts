import { bnbToWei } from '@bsc/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, publicConfig } from '../src/config.js';
import { Db } from '../src/db/database.js';
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
  const setup = () => {
    const db = new Db(':memory:');
    migrate(db);
    const repos = createRepos(db);
    const market = repos.markets.upsert({
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

  it('migrations are idempotent', () => {
    const { db } = setup();
    expect(migrate(db)).toEqual([]);
  });

  it('upserts rounds idempotently on (market, epoch)', () => {
    const { repos, market } = setup();
    expect(repos.rounds.upsert(market.id, write('CHAIN')).result).toBe('inserted');
    expect(repos.rounds.upsert(market.id, write('CHAIN')).result).toBe('unchanged');
    expect(repos.rounds.stats(market.id).total).toBe(1);
  });

  it('never overwrites final chain data; CSV rows can be corrected by chain data with history kept', () => {
    const { db, repos, market } = setup();
    repos.rounds.upsert(market.id, write('CHAIN'));
    expect(repos.rounds.upsert(market.id, write('CHAIN', record(1, { closePrice: 50 }))).result).toBe(
      'conflict',
    );
    expect(repos.rounds.get(market.id, 1)!.closePrice).toBe(200);
    expect(() => db.run('UPDATE rounds SET close_price = 1 WHERE epoch = 1')).toThrow(/immutable/);

    repos.rounds.upsert(market.id, write('CSV_IMPORT', record(2, { closePrice: 50 })));
    const res = repos.rounds.upsert(market.id, write('CHAIN', record(2)));
    expect(res.result).toBe('corrected');
    expect(repos.rounds.get(market.id, 2)!.closePrice).toBe(200);
    expect(repos.rounds.corrections(res.round.id)).toHaveLength(1);
  });

  it('keeps the audit log and trade events append-only', () => {
    const { db, repos } = setup();
    repos.audit.append({ component: 't', severity: 'INFO', type: 'X', message: 'm' });
    expect(() => db.run('UPDATE audit_events SET message = ?', ['x'])).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM audit_events')).toThrow(/append-only/);
  });

  it('guards trade transitions and allows only one live bet per wallet and round', () => {
    const { db, repos, market } = setup();
    const round = repos.rounds.upsert(market.id, write('CHAIN')).round;
    const wallet = repos.wallets.upsert('0x3333333333333333333333333333333333333333', 'SIGNER', 'w');
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
    const t = repos.trades.insert({ ...base, uid: 'a' }, 'created');
    expect(() => repos.trades.insert({ ...base, uid: 'b' }, 'dup')).toThrow(/UNIQUE/);
    expect(() => repos.trades.transition(t.id, 'PENDING', 'SETTLED', {}, 'x')).toThrow(/Illegal/);
    repos.trades.transition(t.id, 'PENDING', 'SUBMITTING', { txHash: '0xabc' }, 'signed');
    expect(() => repos.trades.transition(t.id, 'PENDING', 'SUBMITTING', {}, 'again')).toThrow(/no longer/);
    repos.trades.transition(t.id, 'SUBMITTING', 'FAILED', { error: 'x' }, 'failed');
    // A failed bet frees the slot (the contract never recorded it).
    expect(repos.trades.insert({ ...base, uid: 'c' }, 'retry').status).toBe('PENDING');
    expect(repos.trades.events(t.id).map((e) => e.toStatus)).toEqual(['PENDING', 'SUBMITTING', 'FAILED']);
    expect(() => db.run('DELETE FROM trade_events')).toThrow(/append-only/);
  });
});
