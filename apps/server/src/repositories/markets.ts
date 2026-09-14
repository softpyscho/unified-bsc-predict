import type { Db } from '../db/database.js';
import { big, bigStr, bool, nowIso } from '../db/database.js';

export type Protocol = 'PANCAKESWAP_V2' | 'PANCAKESWAP_V1' | 'PRDT';
export type Timing = 'TIMESTAMP' | 'BLOCK';

export interface Market {
  id: number;
  slug: string;
  name: string;
  symbol: string;
  underlyingAsset: string;
  quoteAsset: string;
  chain: string;
  chainId: number;
  contractAddress: string;
  protocol: Protocol;
  timing: Timing;
  tradable: boolean;
  active: boolean;
  intervalSeconds: number | null;
  bufferSeconds: number | null;
  treasuryFeeBps: number;
  minBetWei: bigint | null;
  oracleAddress: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MarketInput = Omit<Market, 'id' | 'createdAt' | 'updatedAt'>;

interface Row {
  id: number;
  slug: string;
  name: string;
  symbol: string;
  underlying_asset: string;
  quote_asset: string;
  chain: string;
  chain_id: number;
  contract_address: string;
  protocol: Protocol;
  timing: Timing;
  tradable: number;
  active: number;
  interval_seconds: number | null;
  buffer_seconds: number | null;
  treasury_fee_bps: number;
  min_bet_wei: string | null;
  oracle_address: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

const map = (r: Row): Market => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  symbol: r.symbol,
  underlyingAsset: r.underlying_asset,
  quoteAsset: r.quote_asset,
  chain: r.chain,
  chainId: r.chain_id,
  contractAddress: r.contract_address,
  protocol: r.protocol,
  timing: r.timing,
  tradable: r.tradable === 1,
  active: r.active === 1,
  intervalSeconds: r.interval_seconds,
  bufferSeconds: r.buffer_seconds,
  treasuryFeeBps: r.treasury_fee_bps,
  minBetWei: big(r.min_bet_wei),
  oracleAddress: r.oracle_address,
  description: r.description,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class MarketsRepo {
  constructor(private readonly db: Db) {}

  async list(): Promise<Market[]> {
    return (await this.db.all<Row>('SELECT * FROM markets ORDER BY tradable DESC, id')).map(map);
  }

  async get(id: number): Promise<Market | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM markets WHERE id = ?', [id]);
    return r ? map(r) : undefined;
  }

  async bySlug(slug: string): Promise<Market | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM markets WHERE slug = ?', [slug]);
    return r ? map(r) : undefined;
  }

  async upsert(m: MarketInput): Promise<Market> {
    await this.db.run(
      `INSERT INTO markets (slug, name, symbol, underlying_asset, quote_asset, chain, chain_id, contract_address,
         protocol, timing, tradable, active, interval_seconds, buffer_seconds, treasury_fee_bps, min_bet_wei,
         oracle_address, description)
       VALUES (:slug, :name, :symbol, :ua, :qa, :chain, :chainId, :contract, :protocol, :timing, :tradable, :active,
         :interval, :buffer, :fee, :minBet, :oracle, :description)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, symbol = excluded.symbol, chain_id = excluded.chain_id,
         contract_address = excluded.contract_address, protocol = excluded.protocol, timing = excluded.timing,
         tradable = excluded.tradable, active = excluded.active, description = excluded.description,
         interval_seconds = COALESCE(markets.interval_seconds, excluded.interval_seconds),
         buffer_seconds = COALESCE(markets.buffer_seconds, excluded.buffer_seconds),
         treasury_fee_bps = excluded.treasury_fee_bps,
         updated_at = :now`,
      {
        slug: m.slug,
        name: m.name,
        symbol: m.symbol,
        ua: m.underlyingAsset,
        qa: m.quoteAsset,
        chain: m.chain,
        chainId: m.chainId,
        contract: m.contractAddress,
        protocol: m.protocol,
        timing: m.timing,
        tradable: bool(m.tradable),
        active: bool(m.active),
        interval: m.intervalSeconds,
        buffer: m.bufferSeconds,
        fee: m.treasuryFeeBps,
        minBet: bigStr(m.minBetWei),
        oracle: m.oracleAddress,
        description: m.description,
        now: nowIso(),
      },
    );
    return (await this.bySlug(m.slug))!;
  }

  /** Stores parameters read from the contract so they are never hard-coded. */
  async updateParams(
    id: number,
    p: {
      intervalSeconds: number;
      bufferSeconds: number;
      treasuryFeeBps: number;
      minBetWei: bigint;
      oracleAddress: string;
    },
  ): Promise<void> {
    await this.db.run(
      `UPDATE markets SET interval_seconds = ?, buffer_seconds = ?, treasury_fee_bps = ?, min_bet_wei = ?,
         oracle_address = ?, updated_at = ? WHERE id = ?`,
      [
        p.intervalSeconds,
        p.bufferSeconds,
        p.treasuryFeeBps,
        p.minBetWei.toString(),
        p.oracleAddress,
        nowIso(),
        id,
      ],
    );
  }
}
