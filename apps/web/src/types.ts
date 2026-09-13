/** Wire types. bigint wei values arrive as decimal strings. */
import type { ParamSpec, StrategyConfig } from '@bsc/core';

export type Wei = string;
export type Mode = 'PAPER' | 'LIVE';
export type Direction = 'BULL' | 'BEAR';
export type Outcome = 'BULL' | 'BEAR' | 'TIE' | 'CANCELLED';
export type RoundStatus = 'UPCOMING' | 'OPEN' | 'LOCKING' | 'LIVE' | 'CLOSING' | 'ENDED' | 'CANCELLED';

export interface Round {
  id: number;
  marketId: number;
  epoch: number;
  startTime: number | null;
  lockTime: number | null;
  closeTime: number | null;
  startBlock: number | null;
  lockBlock: number | null;
  closeBlock: number | null;
  lockPrice: number | null;
  closePrice: number | null;
  startPrice: number | null;
  lockOracleId: string | null;
  closeOracleId: string | null;
  totalAmount: Wei;
  bullAmount: Wei;
  bearAmount: Wei;
  rewardBaseCalAmount: Wei;
  rewardAmount: Wei;
  oracleCalled: boolean;
  bullPayout: number | null;
  bearPayout: number | null;
  status: RoundStatus;
  outcome: Outcome | null;
  isFinal: boolean;
  source: 'CHAIN' | 'CSV_IMPORT';
  observedAt: number | null;
  extra: Record<string, unknown> | null;
}

export interface MarketState {
  marketId: number;
  marketSlug: string;
  currentEpoch: number;
  chainTime: number;
  blockNumber: string;
  paused: boolean;
  observedAtMs: number;
  stale: boolean;
  lastError: string | null;
  oracle: { price: number; updatedAt: number; roundId: string } | null;
  params: {
    intervalSeconds: number;
    bufferSeconds: number;
    treasuryFeeBps: number;
    minBetWei: Wei;
    oracleAddress: string;
    paused: boolean;
  };
  next: Round | null;
  live: Round | null;
  expired: Round | null;
  later: { epoch: number; startTime: number | null; lockTime: number | null } | null;
}

export interface BotView {
  status: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'EMERGENCY_STOPPED';
  statusReason: string | null;
  liveArmed: boolean;
  liveArmedAt: string | null;
  consecutiveFailures: number;
  updatedAt: string;
  phase: 'RECOVERING' | 'READY';
  canTrade: boolean;
  liveTradingEnabled: boolean;
  paperTradingEnabled: boolean;
  hasSigner: boolean;
  walletAddress: string | null;
  maxExecutionFailures: number;
}

export interface Trade {
  id: number;
  uid: string;
  mode: Mode;
  source: 'BOT' | 'MANUAL' | 'IMPORTED';
  walletId: number | null;
  marketId: number;
  roundId: number;
  epoch: number;
  strategyId: number | null;
  decisionId: number | null;
  direction: Direction;
  amount: Wei;
  entryBullPayout: number | null;
  entryBearPayout: number | null;
  placedAt: number;
  txHash: string | null;
  nonce: number | null;
  blockNumber: number | null;
  gasUsed: Wei | null;
  gasPrice: Wei | null;
  gasCost: Wei | null;
  status: 'PENDING' | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMED' | 'SETTLED' | 'FAILED';
  result: 'WON' | 'LOST' | 'REFUNDED' | null;
  payout: Wei | null;
  grossPnl: Wei | null;
  netPnl: Wei | null;
  claimStatus: 'NOT_APPLICABLE' | 'UNCLAIMED' | 'CLAIMING' | 'CLAIMED';
  claimId: number | null;
  claimGasCost: Wei | null;
  error: string | null;
  errorClass: string | null;
  settledAt: number | null;
  createdAt: string;
  strategySlug?: string | null;
  walletAddress?: string | null;
  running?: { netPnl: Wei; cumulativePnl: Wei; bankrollAfter: Wei | null } | null;
}

export interface RiskCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface Decision {
  id: number;
  strategyId: number;
  marketId: number;
  roundId: number;
  epoch: number;
  mode: Mode;
  signal: 'BUY_UP' | 'BUY_DOWN' | 'WAIT' | 'SKIP' | null;
  confidence: number | null;
  decision: 'TRADE' | 'NO_TRADE';
  direction: Direction | null;
  intendedAmount: Wei | null;
  actualAmount: Wei | null;
  expectedEdge: number | null;
  reason: string;
  rationale: string | null;
  riskChecks: RiskCheck[];
  inputs: Record<string, unknown> | null;
  indicators: Record<string, unknown> | null;
  error: string | null;
  tradeId: number | null;
  decidedAt: number;
  secondsToLock: number | null;
  strategySlug?: string | null;
}

export interface Summary {
  settledTrades: number;
  openTrades: number;
  failedTrades: number;
  wins: number;
  losses: number;
  refunds: number;
  winRate: number | null;
  lossRate: number | null;
  totalWagered: Wei;
  openExposure: Wei;
  totalPayout: Wei;
  grossPnl: Wei;
  fees: Wei;
  netPnl: Wei;
  roi: number | null;
  avgWin: Wei | null;
  avgLoss: Wei | null;
  profitFactor: number | null;
  expectancy: Wei | null;
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: { kind: 'WIN' | 'LOSS' | null; length: number };
  avgStake: Wei | null;
  maxStake: Wei;
  maxDrawdown: Wei;
  maxDrawdownPct: number | null;
}

export interface EquityPoint {
  t: number;
  epoch: number;
  id: number | string;
  net: Wei;
  cumulativePnl: Wei;
  bankroll: Wei | null;
  drawdown: Wei;
}

export interface PeriodPnl {
  period: string;
  netPnl: Wei;
  trades: number;
  wins: number;
}

export interface Bucket {
  label: string;
  count: number;
}

export interface PortfolioReport {
  summary: Summary;
  byStrategy: Record<string, Summary>;
  byMarket: Record<string, Summary>;
  byDirection: Record<Direction, Summary>;
  daily: PeriodPnl[];
  weekly: PeriodPnl[];
  monthly: PeriodPnl[];
  equity: EquityPoint[];
  returnsHistogram: Bucket[];
  stakeHistogram: Bucket[];
  capitalUtilization: number | null;
  startingBankroll: Wei | null;
}

export interface Account {
  mode: Mode;
  walletId: number | null;
  startingBankroll: Wei | null;
  bankrollBasis: 'CONFIGURED' | 'IMPLIED' | 'NONE';
  balance: Wei | null;
  available: Wei | null;
  exposure: Wei;
  claimable: Wei;
  realizedPnl: Wei;
  balanceObservedAt: number | null;
}

export interface AuditEvent {
  id: number;
  ts: number;
  component: string;
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  type: string;
  marketId: number | null;
  epoch: number | null;
  strategyId: number | null;
  tradeId: number | null;
  txHash: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
}

export interface StrategyView {
  id: number;
  slug: string;
  name: string;
  version: string;
  description: string;
  marketId: number;
  config: StrategyConfig;
  enabled: boolean;
  paperTradingEnabled: boolean;
  liveTradingEnabled: boolean;
  plugin: {
    id: string;
    name: string;
    version: string;
    description: string;
    params: ParamSpec[];
    defaults: Record<string, unknown>;
  } | null;
  performance: Record<Mode, Summary>;
  decisions: { total: number; trades: number };
}

export interface Market {
  id: number;
  slug: string;
  name: string;
  symbol: string;
  chainId: number;
  contractAddress: string;
  protocol: string;
  timing: 'TIMESTAMP' | 'BLOCK';
  tradable: boolean;
  active: boolean;
  intervalSeconds: number | null;
  bufferSeconds: number | null;
  treasuryFeeBps: number;
  minBetWei: Wei | null;
  oracleAddress: string | null;
  description: string | null;
  stats: {
    total: number;
    final: number;
    minEpoch: number | null;
    maxEpoch: number | null;
    bull: number;
    bear: number;
    tie: number;
    cancelled: number;
  };
  timeRange: { minStart: number | null; maxStart: number | null };
}

export interface ModeOverview {
  account: Account;
  summary: Summary;
  todayPnl: Wei;
  todayTrades: number;
}
