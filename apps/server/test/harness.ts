import { bnbToWei } from '@bsc/core';
import type { Address } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { createApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLoggers } from '../src/logger.js';
import { FakeChain, FakeWriter } from './fakeChain.js';

export const TOKEN = 'test-admin-token-0123456789abcdef';
export const ALICE: Address = '0x1111111111111111111111111111111111111111';
export const BOB: Address = '0x2222222222222222222222222222222222222222';

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ADMIN_API_TOKEN: TOKEN,
    DATABASE_URL: 'memory:',
    LOG_DIR: 'none',
    LOG_LEVEL: 'silent',
    CONFIRMATIONS: '0',
    SERVE_WEB: 'false',
    DEFAULT_BET_SIZE: '0.01',
    MAX_BET_SIZE: '0.01',
    MAX_TOTAL_EXPOSURE: '0.05',
    MAX_DAILY_LOSS: '1',
    MIN_WALLET_BALANCE: '0',
    MAX_CONSECUTIVE_LOSSES: '0',
    MAX_EXECUTION_FAILURES: '2',
    CLAIM_BATCH_MIN: '1',
    ...overrides,
  };
}

export interface Harness {
  chain: FakeChain;
  app: App;
  writer: FakeWriter | null;
  privateKey: `0x${string}` | null;
}

export async function makeHarness(
  opts: { live?: boolean; env?: Record<string, string>; chain?: FakeChain; privateKey?: `0x${string}` } = {},
): Promise<Harness> {
  const chain = opts.chain ?? new FakeChain();
  if (!opts.chain) chain.boot();
  const privateKey = opts.live ? (opts.privateKey ?? generatePrivateKey()) : null;
  const config = loadConfig(
    testEnv({
      ...(opts.live ? { LIVE_TRADING_ENABLED: 'true', PRIVATE_KEY: privateKey! } : {}),
      ...(opts.env ?? {}),
    }),
  );
  const writer = opts.live ? new FakeWriter(chain, config.walletAddress!) : null;
  const app = await createApp(config, {
    reader: chain,
    writer,
    loggers: silentLoggers(),
    clock: { nowMs: () => chain.time * 1000 },
  });
  return { chain, app, writer, privateKey };
}

/** Market snapshot + strategy evaluation, then waits for any live submission to finish. */
export async function tick(h: Harness): Promise<void> {
  const state = await h.app.monitor.tick();
  if (state) await h.app.engine.onMarketState(state);
  await settleAsync(h);
}

export async function settleAsync(h: Harness): Promise<void> {
  for (let i = 0; i < 200 && h.app.execution.inflightCount > 0; i++)
    await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => setImmediate(r));
}

/**
 * One full round: liquidity from other users, a decision tick 20 s before lock, then the operator executes the
 * round with `price` (which also ends the previous round), followed by a monitor tick.
 */
export async function playRound(h: Harness, price: number, liquidity = true): Promise<number> {
  const epoch = h.chain.currentEpoch;
  const round = h.chain.round(epoch);
  if (liquidity) {
    h.chain.setTime(round.startTime! + 10);
    h.chain.externalBet(ALICE, 'BULL', bnbToWei('1'));
    h.chain.externalBet(BOB, 'BEAR', bnbToWei('1.5'));
  }
  h.chain.setTime(round.lockTime! - 20);
  await tick(h);
  h.chain.execute(price);
  await tick(h);
  return epoch;
}

export const bearer = { authorization: `Bearer ${TOKEN}` };
