/**
 * Environment configuration. Validated once at startup; the process refuses to start with a clear list of
 * every problem. Secrets live on a non-enumerable property so they are never serialized or logged.
 */
import type { RiskLimits } from '@bsc/core';
import { bnbToWei, gweiToWei, weiToBnbString } from '@bsc/core';
import path from 'node:path';
import type { Address, Hex } from 'viem';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const boolish = z.string().transform((v, ctx) => {
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  ctx.addIssue({ code: 'custom', message: 'must be true or false' });
  return z.NEVER;
});
const bnb = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,18})?$/, 'must be a BNB amount such as 0.01')
  .transform((v) => bnbToWei(v));
const address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
  .transform((v) => getAddress(v));
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: int(1, 65535).default(8080),
  DATABASE_URL: z.string().default('pglite:./data/pg'),
  RPC_URL: z.url().optional(),
  RPC_URLS: z
    .string()
    .default(
      'https://bsc-dataseed.bnbchain.org,https://bsc-dataseed1.defibit.io,https://bsc-dataseed1.ninicoin.io',
    ),
  /** eth_getLogs endpoints: BNB Chain's dataseeds reject eth_getLogs; 48.club serves logs with block timestamps. */
  LOG_RPC_URLS: z.string().default('https://rpc-bsc.48.club'),
  POOL_EVENTS_ENABLED: boolish.default(true),
  POOL_EVENTS_CHUNK_BLOCKS: int(10, 50_000).default(5000),
  POOL_EVENTS_BACKFILL_BLOCKS: int(0, 50_000_000).default(600_000),
  CHAIN_ID: z.coerce
    .number()
    .refine((v) => v === 56 || v === 97, 'must be 56 (BSC) or 97 (BSC testnet)')
    .default(56),
  CONTRACT_ADDRESS: address.default(getAddress('0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA')),
  MARKET_SLUG: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('pancakeswap-bnb-v2'),
  PRIVATE_KEY: z
    .string()
    .trim()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key')
    .optional(),
  WALLET_ADDRESS: address.optional(),
  ADMIN_API_TOKEN: z
    .string()
    .min(24, 'must be at least 24 characters (generate one with: openssl rand -hex 32)'),
  LIVE_TRADING_ENABLED: boolish.default(false),
  PAPER_TRADING_ENABLED: boolish.default(true),
  BOT_AUTO_RESUME_LIVE: boolish.default(false),
  PAPER_STARTING_BANKROLL: bnb.default(bnbToWei('1')),
  DEFAULT_BET_SIZE: bnb.default(bnbToWei('0.001')),
  MAX_BET_SIZE: bnb.default(bnbToWei('0.01')),
  MIN_BET_SIZE: bnb.default(0n),
  ESCALATION_STAKE_THRESHOLD: bnb.default(0n),
  ESCALATION_MIN_LOSS_STREAK: int(0, 1000).default(0),
  MAX_BANKROLL_FRACTION: num(0, 1).default(0.05),
  MAX_DAILY_LOSS: bnb.default(bnbToWei('0.05')),
  MAX_CONSECUTIVE_LOSSES: int(0, 1000).default(5),
  COOLDOWN_ROUNDS: int(0, 10_000).default(12),
  MAX_TOTAL_EXPOSURE: bnb.default(bnbToWei('0.05')),
  MIN_WALLET_BALANCE: bnb.default(bnbToWei('0.01')),
  MAX_GAS_PRICE_GWEI: num(0.001, 1000).default(5),
  MIN_SECONDS_BEFORE_LOCK: int(2, 120).default(6),
  MAX_EXECUTION_FAILURES: int(1, 100).default(3),
  SIMULATED_GAS_PER_BET: bnb.default(bnbToWei('0.00001')),
  SIMULATED_GAS_PER_CLAIM: bnb.default(bnbToWei('0.00001')),
  CLAIM_BATCH_MIN: int(1, 100).default(3),
  CLAIM_MAX_DELAY_MINUTES: int(1, 10_080).default(60),
  POLL_INTERVAL_MS: int(1000, 60_000).default(3000),
  WALLET_SYNC_INTERVAL_MS: int(10_000, 3_600_000).default(60_000),
  RECONCILE_INTERVAL_MS: int(60_000, 86_400_000).default(600_000),
  CONFIRMATIONS: int(0, 100).default(3),
  SYNC_BATCH_SIZE: int(10, 1000).default(200),
  SYNC_CONCURRENCY: int(1, 8).default(2),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_DIR: z.string().default('./logs'),
  SERVE_WEB: boolish.default(true),
  WEB_DIST_DIR: z.string().optional(),
});

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  /** `postgres://…` (Postgres, Supabase), `pglite:<dir>` (embedded) or `memory:` (tests). */
  databaseUrl: string;
  rpcUrls: string[];
  /** Endpoints used for eth_getLogs (bet events). */
  logRpcUrls: string[];
  poolEvents: {
    enabled: boolean;
    chunkBlocks: number;
    /** How far below the first collected block to backfill (0 = never). */
    backfillBlocks: number;
  };
  chainId: 56 | 97;
  contractAddress: Address;
  marketSlug: string;
  /** Address of the signing wallet (derived from PRIVATE_KEY), or a watch-only WALLET_ADDRESS. */
  walletAddress: Address | null;
  hasSigner: boolean;
  liveTradingEnabled: boolean;
  paperTradingEnabled: boolean;
  botAutoResumeLive: boolean;
  paperStartingBankrollWei: bigint;
  defaultBetWei: bigint;
  risk: RiskLimits;
  maxExecutionFailures: number;
  simulatedGasPerBetWei: bigint;
  simulatedGasPerClaimWei: bigint;
  claimBatchMin: number;
  claimMaxDelayMs: number;
  pollIntervalMs: number;
  walletSyncIntervalMs: number;
  reconcileIntervalMs: number;
  confirmations: number;
  syncBatchSize: number;
  syncConcurrency: number;
  logLevel: string;
  logDir: string | null;
  serveWeb: boolean;
  webDistDir: string | null;
  /** Non-enumerable: never serialized, never logged. */
  readonly secrets: { readonly privateKey: Hex | null; readonly adminToken: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty values as unset so `.env.example` placeholders like `PRIVATE_KEY=` are harmless.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`));
  }
  const e = parsed.data;
  const issues: string[] = [];

  let privateKey: Hex | null = null;
  let walletAddress: Address | null = e.WALLET_ADDRESS ?? null;
  if (e.PRIVATE_KEY) {
    privateKey = (e.PRIVATE_KEY.startsWith('0x') ? e.PRIVATE_KEY : `0x${e.PRIVATE_KEY}`) as Hex;
    try {
      const derived = privateKeyToAccount(privateKey).address;
      if (walletAddress && walletAddress !== derived) {
        issues.push(`WALLET_ADDRESS ${walletAddress} does not match the address derived from PRIVATE_KEY`);
      }
      walletAddress = derived;
    } catch {
      issues.push('PRIVATE_KEY: not a valid secp256k1 private key');
    }
  }
  if (e.LIVE_TRADING_ENABLED && !privateKey) issues.push('LIVE_TRADING_ENABLED=true requires PRIVATE_KEY');
  if (e.MAX_BET_SIZE > e.MAX_TOTAL_EXPOSURE) issues.push('MAX_BET_SIZE must not exceed MAX_TOTAL_EXPOSURE');
  if (e.DEFAULT_BET_SIZE > e.MAX_BET_SIZE) issues.push('DEFAULT_BET_SIZE must not exceed MAX_BET_SIZE');
  if (/^file:|\.db$/i.test(e.DATABASE_URL.trim()))
    issues.push(
      'DATABASE_URL points to a SQLite file, but the app now uses PostgreSQL. Import it once with ' +
        '`npm run app -- import-sqlite <file>` and set DATABASE_URL=pglite:./data/pg (embedded) or a postgres:// URL',
    );
  if (e.MIN_BET_SIZE > e.MAX_BET_SIZE) issues.push('MIN_BET_SIZE must not exceed MAX_BET_SIZE');
  if (e.ESCALATION_STAKE_THRESHOLD > 0n) {
    if (e.ESCALATION_STAKE_THRESHOLD < e.MIN_BET_SIZE)
      issues.push('ESCALATION_STAKE_THRESHOLD must not be below MIN_BET_SIZE');
    if (e.ESCALATION_MIN_LOSS_STREAK < 1)
      issues.push('ESCALATION_STAKE_THRESHOLD requires ESCALATION_MIN_LOSS_STREAK >= 1');
  }
  if (e.ADMIN_API_TOKEN.toLowerCase().includes('replace'))
    issues.push('ADMIN_API_TOKEN: replace the placeholder value');
  if (issues.length > 0) throw new ConfigError(issues);

  const rpcUrls = [...(e.RPC_URL ? [e.RPC_URL] : []), ...e.RPC_URLS.split(',').map((s) => s.trim())].filter(
    (u, i, all) => u.length > 0 && all.indexOf(u) === i,
  );
  const dbUrl = e.DATABASE_URL.trim();
  const databaseUrl = /^postgres(ql)?:\/\//.test(dbUrl)
    ? dbUrl
    : dbUrl === 'memory:' || dbUrl === ':memory:'
      ? 'memory:'
      : `pglite:${path.resolve(dbUrl.replace(/^pglite:/, ''))}`;

  const config: Omit<AppConfig, 'secrets'> = {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl,
    rpcUrls,
    logRpcUrls: e.LOG_RPC_URLS.split(',')
      .map((s) => s.trim())
      .filter((u, i, all) => u.length > 0 && all.indexOf(u) === i),
    poolEvents: {
      enabled: e.POOL_EVENTS_ENABLED,
      chunkBlocks: e.POOL_EVENTS_CHUNK_BLOCKS,
      backfillBlocks: e.POOL_EVENTS_BACKFILL_BLOCKS,
    },
    chainId: e.CHAIN_ID as 56 | 97,
    contractAddress: e.CONTRACT_ADDRESS,
    marketSlug: e.MARKET_SLUG,
    walletAddress,
    hasSigner: privateKey !== null,
    liveTradingEnabled: e.LIVE_TRADING_ENABLED,
    paperTradingEnabled: e.PAPER_TRADING_ENABLED,
    botAutoResumeLive: e.BOT_AUTO_RESUME_LIVE,
    paperStartingBankrollWei: e.PAPER_STARTING_BANKROLL,
    defaultBetWei: e.DEFAULT_BET_SIZE,
    risk: {
      maxStakeWei: e.MAX_BET_SIZE,
      minStakeWei: e.MIN_BET_SIZE,
      escalationStakeWei: e.ESCALATION_STAKE_THRESHOLD,
      escalationMinLossStreak: e.ESCALATION_MIN_LOSS_STREAK,
      maxBankrollFraction: e.MAX_BANKROLL_FRACTION,
      maxDailyLossWei: e.MAX_DAILY_LOSS,
      maxConsecutiveLosses: e.MAX_CONSECUTIVE_LOSSES,
      cooldownRounds: e.COOLDOWN_ROUNDS,
      maxExposureWei: e.MAX_TOTAL_EXPOSURE,
      minWalletBalanceWei: e.MIN_WALLET_BALANCE,
      maxGasPriceWei: gweiToWei(e.MAX_GAS_PRICE_GWEI),
      stopLossWei: null,
      minConfidence: 0,
      minExpectedEdge: null,
      minSecondsBeforeLock: e.MIN_SECONDS_BEFORE_LOCK,
    },
    maxExecutionFailures: e.MAX_EXECUTION_FAILURES,
    simulatedGasPerBetWei: e.SIMULATED_GAS_PER_BET,
    simulatedGasPerClaimWei: e.SIMULATED_GAS_PER_CLAIM,
    claimBatchMin: e.CLAIM_BATCH_MIN,
    claimMaxDelayMs: e.CLAIM_MAX_DELAY_MINUTES * 60_000,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    walletSyncIntervalMs: e.WALLET_SYNC_INTERVAL_MS,
    reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
    confirmations: e.CONFIRMATIONS,
    syncBatchSize: e.SYNC_BATCH_SIZE,
    syncConcurrency: e.SYNC_CONCURRENCY,
    logLevel: e.LOG_LEVEL,
    logDir: e.LOG_DIR === 'none' ? null : path.resolve(e.LOG_DIR),
    serveWeb: e.SERVE_WEB,
    webDistDir: e.WEB_DIST_DIR ? path.resolve(e.WEB_DIST_DIR) : null,
  };
  Object.defineProperty(config, 'secrets', {
    value: Object.freeze({ privateKey, adminToken: e.ADMIN_API_TOKEN }),
    enumerable: false,
    writable: false,
  });
  return Object.freeze(config) as AppConfig;
}

/** Safe-to-display configuration (Settings page). Contains no secrets. */
export function publicConfig(c: AppConfig) {
  const w = (v: bigint) => weiToBnbString(v);
  return {
    env: c.env,
    chainId: c.chainId,
    contractAddress: c.contractAddress,
    marketSlug: c.marketSlug,
    rpcUrls: c.rpcUrls.map((u) => u.replace(/\/\/([^@/]+)@/, '//***@')),
    logRpcUrls: c.logRpcUrls.map((u) => u.replace(/\/\/([^@/]+)@/, '//***@')),
    poolEvents: c.poolEvents,
    walletAddress: c.walletAddress,
    hasSigner: c.hasSigner,
    liveTradingEnabled: c.liveTradingEnabled,
    paperTradingEnabled: c.paperTradingEnabled,
    botAutoResumeLive: c.botAutoResumeLive,
    paperStartingBankroll: w(c.paperStartingBankrollWei),
    defaultBetSize: w(c.defaultBetWei),
    risk: {
      maxBetSize: w(c.risk.maxStakeWei),
      minBetSize: w(c.risk.minStakeWei),
      escalationStakeThreshold: w(c.risk.escalationStakeWei),
      escalationMinLossStreak: c.risk.escalationMinLossStreak,
      maxBankrollFraction: c.risk.maxBankrollFraction,
      maxDailyLoss: w(c.risk.maxDailyLossWei),
      maxConsecutiveLosses: c.risk.maxConsecutiveLosses,
      cooldownRounds: c.risk.cooldownRounds,
      maxTotalExposure: w(c.risk.maxExposureWei),
      minWalletBalance: w(c.risk.minWalletBalanceWei),
      maxGasPriceGwei: c.risk.maxGasPriceWei === null ? null : Number(c.risk.maxGasPriceWei) / 1e9,
      minSecondsBeforeLock: c.risk.minSecondsBeforeLock,
    },
    maxExecutionFailures: c.maxExecutionFailures,
    simulatedGasPerBet: w(c.simulatedGasPerBetWei),
    simulatedGasPerClaim: w(c.simulatedGasPerClaimWei),
    claimBatchMin: c.claimBatchMin,
    pollIntervalMs: c.pollIntervalMs,
    confirmations: c.confirmations,
    logLevel: c.logLevel,
  };
}
