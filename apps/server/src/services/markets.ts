/** Market registry: seeds markets/strategies/wallet and keeps contract parameters in sync with the chain. */
import { BUILTIN_STRATEGIES, defaultStrategyConfig, manualOrder, sequenceRecovery } from '@bsc/core';
import type { StrategyPlugin } from '@bsc/core';
import { getAddress } from 'viem';
import type { ContractParams } from '../chain/types.js';
import type { Market } from '../repositories/index.js';
import type { MarketInput } from '../repositories/markets.js';
import type { Ctx } from './context.js';

export const PANCAKESWAP_V2_MAINNET = getAddress('0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA');

/** Retired contracts whose history was archived by bsc-predict-updater. Read-only; never traded or synced. */
export const HISTORICAL_MARKETS: readonly MarketInput[] = [
  {
    slug: 'pancakeswap-bnb-v1',
    name: 'PancakeSwap BNB/USD Prediction V1 (retired)',
    symbol: 'BNBUSD',
    underlyingAsset: 'BNB',
    quoteAsset: 'USD',
    chain: 'bsc',
    chainId: 56,
    contractAddress: getAddress('0x516ffd7d1e0ca40b1879935b2de87cb20fc1124b'),
    protocol: 'PANCAKESWAP_V1',
    timing: 'BLOCK',
    tradable: false,
    active: false,
    intervalSeconds: null,
    bufferSeconds: null,
    treasuryFeeBps: 300,
    minBetWei: null,
    oracleAddress: null,
    description:
      'Block-timed V1 contract, paused at epoch 20541. Historical rounds imported from bsc-predict-updater; no timestamps, so not backtestable.',
  },
  {
    slug: 'prdt-bnb',
    name: 'PRDT BNB Prediction (retired)',
    symbol: 'BNBUSD',
    underlyingAsset: 'BNB',
    quoteAsset: 'USD',
    chain: 'bsc',
    chainId: 56,
    contractAddress: getAddress('0x5C7D19566c330Be63458510AD45B7d5fb6EB7403'),
    protocol: 'PRDT',
    timing: 'TIMESTAMP',
    tradable: false,
    active: false,
    intervalSeconds: 300,
    bufferSeconds: 30,
    treasuryFeeBps: 10,
    minBetWei: null,
    oracleAddress: null,
    description:
      'Paused PRDT contract. Historical rounds imported from bsc-predict-updater; referral bonuses are stored but not modelled in backtests.',
  },
];

export class MarketService {
  private cached: { params: ContractParams; at: number } | null = null;
  /** The tradable market row, loaded by `seed()` and refreshed whenever contract parameters are re-read. */
  private tradableMarket: Market | null = null;

  constructor(private readonly ctx: Ctx) {}

  /** Idempotent: safe to run on every start. Never overwrites operator-edited strategy configs. */
  async seed(): Promise<Market> {
    const { config, repos } = this.ctx;
    const tradable = await repos.markets.upsert({
      slug: config.marketSlug,
      name:
        config.chainId === 56
          ? 'PancakeSwap BNB/USD Prediction V2'
          : 'PancakeSwap BNB/USD Prediction V2 (testnet)',
      symbol: 'BNBUSD',
      underlyingAsset: 'BNB',
      quoteAsset: 'USD',
      chain: config.chainId === 56 ? 'bsc' : 'bsc-testnet',
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      protocol: 'PANCAKESWAP_V2',
      timing: 'TIMESTAMP',
      tradable: true,
      active: true,
      intervalSeconds: 300,
      bufferSeconds: 30,
      treasuryFeeBps: 300,
      minBetWei: null,
      oracleAddress: null,
      description:
        '5-minute binary rounds on the Chainlink BNB/USD price. Parameters are read from the contract.',
    });
    if (config.chainId === 56) for (const m of HISTORICAL_MARKETS) await repos.markets.upsert(m);

    const plugins: StrategyPlugin[] = [...BUILTIN_STRATEGIES, manualOrder as StrategyPlugin];
    for (const plugin of plugins) {
      const isManual = plugin.id === manualOrder.id;
      const seedConfig = defaultStrategyConfig(plugin, Number(config.defaultBetWei) / 1e18);
      if (plugin.id === sequenceRecovery.id) {
        // The recovery ladder sizes its own stake per step (see sequenceRecovery's `stakeFor`), so it must
        // be seeded with sizing.mode SIGNAL — a fixed per-trade stake would defeat the ladder entirely.
        seedConfig.sizing.mode = 'SIGNAL';
      }
      await repos.strategies.insertIfMissing({
        slug: plugin.id,
        plugin: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        marketId: tradable.id,
        config: seedConfig,
        enabled: isManual,
        paperTradingEnabled: true,
        liveTradingEnabled: false,
      });
    }
    if (config.walletAddress) {
      const existing = await repos.wallets.byAddress(config.walletAddress);
      const kind = config.hasSigner ? 'SIGNER' : 'WATCH';
      if (!existing || existing.kind !== kind) {
        await repos.wallets.upsert(
          config.walletAddress,
          kind,
          config.hasSigner ? 'Bot wallet' : 'Watched wallet',
        );
      }
    }
    this.tradableMarket = tradable;
    return tradable;
  }

  tradable(): Market {
    if (!this.tradableMarket) throw new Error('tradable market not seeded');
    return this.tradableMarket;
  }

  get cachedParams(): ContractParams | null {
    return this.cached?.params ?? null;
  }

  /** Contract parameters, refreshed from chain at most every `maxAgeMs`. */
  async params(maxAgeMs = 10 * 60_000): Promise<ContractParams> {
    if (this.cached && this.ctx.clock.nowMs() - this.cached.at < maxAgeMs) return this.cached.params;
    const params = await this.ctx.reader.getParams();
    const id = this.tradable().id;
    await this.ctx.repos.markets.updateParams(id, params);
    this.tradableMarket = (await this.ctx.repos.markets.get(id)) ?? this.tradableMarket;
    this.cached = { params, at: this.ctx.clock.nowMs() };
    return params;
  }
}
