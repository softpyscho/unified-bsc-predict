/**
 * Chain ports. Services depend on these interfaces only; `viem.ts` implements them against BSC and the tests
 * implement them with an in-memory simulation of the PancakeSwap V2 contract.
 */
import type { Direction, RoundRecord } from '@bsc/core';

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface ContractParams {
  intervalSeconds: number;
  bufferSeconds: number;
  treasuryFeeBps: number;
  minBetWei: bigint;
  oracleAddress: Address;
  paused: boolean;
}

export interface OraclePrice {
  /** 8-decimal integer. */
  price: number;
  updatedAt: number;
  roundId: string;
}

/** One consistent read of the contract at a single block. */
export interface ChainSnapshot {
  blockNumber: bigint;
  blockTimestamp: number;
  currentEpoch: number;
  paused: boolean;
  /** rounds(currentEpoch), rounds(currentEpoch − 1), rounds(currentEpoch − 2), when they exist. */
  rounds: RoundRecord[];
  oracle: OraclePrice | null;
}

export interface ChainHead {
  blockNumber: bigint;
  blockTimestamp: number;
  currentEpoch: number;
}

export interface LedgerEntry {
  position: Direction;
  amount: bigint;
  claimed: boolean;
}

export interface UserRound extends LedgerEntry {
  epoch: number;
}

/** One BetBull/BetBear log. */
export interface BetEvent {
  epoch: number;
  direction: Direction;
  sender: Address;
  amount: bigint;
  blockNumber: bigint;
  /** Block timestamp, unix seconds. */
  blockTime: number;
  txHash: Hex;
  logIndex: number;
}

export interface PredictionReader {
  getParams(): Promise<ContractParams>;
  /** BetBull/BetBear logs in [fromBlock, toBlock] (inclusive), ordered by block and log index. */
  getBetEvents(fromBlock: bigint, toBlock: bigint): Promise<BetEvent[]>;
  getSnapshot(): Promise<ChainSnapshot>;
  /** Head (or the given historical block) with its timestamp and the contract's currentEpoch at that block. */
  getHead(blockNumber?: bigint): Promise<ChainHead>;
  getReceipt(hash: Hex): Promise<TxReceipt | null>;
  /** Reads rounds(epoch) for every epoch at `blockNumber` (default latest). */
  getRounds(epochs: readonly number[], blockNumber?: bigint): Promise<RoundRecord[]>;
  getLedger(epoch: number, address: Address): Promise<LedgerEntry>;
  getUserRoundsLength(address: Address): Promise<number>;
  getUserRounds(
    address: Address,
    cursor: number,
    size: number,
  ): Promise<{ rounds: UserRound[]; nextCursor: number }>;
  getClaimStatus(
    epochs: readonly number[],
    address: Address,
  ): Promise<{ epoch: number; claimable: boolean; refundable: boolean }[]>;
  getBalance(address: Address): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  /**
   * Simulates betBull/betBear from `from` against the latest state (eth_call with the sender's balance overridden
   * to cover the stake). Resolves when the contract would accept the bet; throws its revert otherwise. Never
   * broadcasts.
   */
  simulateBet(direction: Direction, epoch: number, value: bigint, from: Address): Promise<void>;
}

/** A signed, not yet broadcast transaction. Its hash is known before broadcast and persisted first. */
export interface PreparedTx {
  hash: Hex;
  serialized: Hex;
  nonce: number;
  gasLimit: bigint;
  gasPrice: bigint;
}

export interface TxReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface PredictionWriter {
  readonly address: Address;
  /** Simulates (reverts surface here), estimates gas and signs locally. Does not broadcast. */
  prepareBet(direction: Direction, epoch: number, value: bigint): Promise<PreparedTx>;
  prepareClaim(epochs: readonly number[]): Promise<PreparedTx>;
  /** Broadcasts a signed tx. Safe to repeat: the same signed bytes can only be mined once. */
  broadcast(tx: PreparedTx): Promise<void>;
  getReceipt(hash: Hex): Promise<TxReceipt | null>;
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<TxReceipt | null>;
}

/** Classified execution failure; drives retry/circuit-breaker decisions. */
export type ExecutionErrorClass =
  | 'INSUFFICIENT_FUNDS'
  | 'CONTRACT_REVERT'
  | 'NONCE'
  | 'UNDERPRICED'
  | 'ALREADY_KNOWN'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'UNKNOWN';

export class ExecutionError extends Error {
  constructor(
    readonly errorClass: ExecutionErrorClass,
    message: string,
    /** True when the tx may have reached the mempool and must be reconciled rather than assumed failed. */
    readonly maybeBroadcast = false,
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export function classifyError(err: unknown): ExecutionError {
  if (err instanceof ExecutionError) return err;
  const msg = (
    err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ''}` : String(err)
  ).toLowerCase();
  if (msg.includes('insufficient funds'))
    return new ExecutionError('INSUFFICIENT_FUNDS', 'insufficient funds for stake + gas');
  if (msg.includes('already known'))
    return new ExecutionError('ALREADY_KNOWN', 'transaction already in mempool', true);
  if (msg.includes('nonce too low') || msg.includes('nonce has already been used'))
    return new ExecutionError('NONCE', 'nonce already used', true);
  if (msg.includes('underpriced')) return new ExecutionError('UNDERPRICED', 'gas price too low');
  if (msg.includes('execution reverted') || msg.includes('reverted') || msg.includes('revert')) {
    // viem: 'The contract function "betBull" reverted with the following reason:\n<reason>'.
    const full = err instanceof Error ? err.message : String(err);
    const reason =
      /following reason:\s*\n\s*([^\n]+)/i.exec(full)?.[1] ??
      /reverted with reason string\s*["']([^"']+)/i.exec(full)?.[1] ??
      /execution reverted:?\s*([^\n]*)/i.exec(full)?.[1];
    return new ExecutionError(
      'CONTRACT_REVERT',
      `contract reverted${reason?.trim() ? `: ${reason.trim()}` : ''}`,
    );
  }
  if (msg.includes('timeout') || msg.includes('timed out'))
    return new ExecutionError('TIMEOUT', 'RPC request timed out', true);
  if (
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('network') ||
    msg.includes('http request failed')
  )
    return new ExecutionError('NETWORK', 'RPC unavailable', true);
  return new ExecutionError(
    'UNKNOWN',
    err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    true,
  );
}
