/** Trade lifecycle. Every state change goes through `assertTransition`; history is never rewritten. */
import type { Direction, RoundOutcome } from './round.js';

export type TradeMode = 'PAPER' | 'LIVE';
export type RunMode = 'BACKTEST' | TradeMode;
export type TradeSource = 'BOT' | 'MANUAL' | 'IMPORTED';
export type TradeStatus = 'PENDING' | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMED' | 'SETTLED' | 'FAILED';
export type TradeResult = 'WON' | 'LOST' | 'REFUNDED';
export type ClaimStatus = 'NOT_APPLICABLE' | 'UNCLAIMED' | 'CLAIMING' | 'CLAIMED';

export const TRADE_STATUSES: readonly TradeStatus[] = [
  'PENDING',
  'SUBMITTING',
  'SUBMITTED',
  'CONFIRMED',
  'SETTLED',
  'FAILED',
];

/**
 * PENDING → SUBMITTING → SUBMITTED → CONFIRMED → SETTLED, and any pre-confirmation state → FAILED.
 * Paper and imported trades go PENDING → CONFIRMED directly. Recovery may jump SUBMITTING → CONFIRMED
 * when a receipt is found for a transaction whose broadcast result was never recorded.
 */
const TRANSITIONS: Readonly<Record<TradeStatus, readonly TradeStatus[]>> = {
  PENDING: ['SUBMITTING', 'CONFIRMED', 'FAILED'],
  SUBMITTING: ['SUBMITTED', 'CONFIRMED', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'FAILED'],
  CONFIRMED: ['SETTLED'],
  SETTLED: [],
  FAILED: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TradeStatus,
    readonly to: TradeStatus,
  ) {
    super(`Illegal trade status transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: TradeStatus, to: TradeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TradeStatus, to: TradeStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isOpenStatus(status: TradeStatus): boolean {
  return status === 'PENDING' || status === 'SUBMITTING' || status === 'SUBMITTED' || status === 'CONFIRMED';
}

/** A tie is a loss: the contract sends the whole pool to the treasury and nothing is claimable. */
export function resultFor(outcome: RoundOutcome, direction: Direction): TradeResult {
  if (outcome === 'CANCELLED') return 'REFUNDED';
  return outcome === direction ? 'WON' : 'LOST';
}

/** Whether a settled live trade leaves funds in the contract that must be claimed. */
export function claimStatusFor(mode: TradeMode, result: TradeResult): ClaimStatus {
  if (mode === 'PAPER') return 'NOT_APPLICABLE';
  return result === 'LOST' ? 'NOT_APPLICABLE' : 'UNCLAIMED';
}

export interface PnlInput {
  status: TradeStatus;
  amount: bigint;
  payout: bigint | null;
  gasCost: bigint | null;
  claimGasCost: bigint | null;
}

/** Gross P&L (payout − stake) of a settled trade; null while open or when failed. */
export function tradeGrossPnl(t: PnlInput): bigint | null {
  if (t.status !== 'SETTLED' || t.payout === null) return null;
  return t.payout - t.amount;
}

/** Net P&L including gas. A failed trade that reached the chain still costs the gas it burned. */
export function tradeNetPnl(t: PnlInput): bigint | null {
  const fees = (t.gasCost ?? 0n) + (t.claimGasCost ?? 0n);
  if (t.status === 'FAILED') return fees === 0n ? 0n : -fees;
  const gross = tradeGrossPnl(t);
  return gross === null ? null : gross - fees;
}
