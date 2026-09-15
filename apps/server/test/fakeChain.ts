/**
 * In-memory simulation of the PancakeSwap Prediction V2 contract, implementing the same chain ports as the viem
 * adapter. Models genesis, executeRound timing (lock/end must happen within bufferSeconds), reward calculation,
 * the bettable window, one bet per round, claims/refunds, gas, and injectable RPC/broadcast failures.
 */
import type { Direction, RoundRecord } from '@bsc/core';
import { keccak256, stringToHex } from 'viem';
import type {
  Address,
  BetEvent,
  ChainHead,
  ChainSnapshot,
  ContractParams,
  Hex,
  LedgerEntry,
  PredictionReader,
  PredictionWriter,
  PreparedTx,
  TxReceipt,
  UserRound,
} from '../src/chain/types.js';

export const GAS_USED = 100_000n;
export const GAS_PRICE = 1_000_000_000n;
export const GAS_COST = GAS_USED * GAS_PRICE;
const ORACLE: Address = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';

type Tx =
  | { kind: 'bet'; from: Address; direction: Direction; epoch: number; value: bigint }
  | { kind: 'claim'; from: Address; epochs: number[] };

const k = (epoch: number, a: string) => `${epoch}:${a.toLowerCase()}`;

const empty = (epoch: number): RoundRecord => ({
  epoch,
  startTime: null,
  lockTime: null,
  closeTime: null,
  lockPrice: null,
  closePrice: null,
  lockOracleId: null,
  closeOracleId: null,
  totalAmount: 0n,
  bullAmount: 0n,
  bearAmount: 0n,
  rewardBaseCalAmount: 0n,
  rewardAmount: 0n,
  oracleCalled: false,
});

export class FakeChain implements PredictionReader {
  time: number;
  blockNumber = 1_000n;
  currentEpoch = 0;
  paused = false;
  readonly intervalSeconds = 300;
  readonly bufferSeconds = 30;
  readonly treasuryFeeBps = 300;
  readonly minBetWei = 10n ** 15n;
  price = 60_000_000_000;
  snapshotFailures = 0;
  /** Transient eth_getLogs failures to inject. */
  logFailures = 0;
  /** Revert reason injected into the next bet simulation (shadow checks). */
  simulateRevert: string | null = null;
  /** Transient failures injected into bet simulations. */
  simulateFailures = 0;
  /** Log requests reaching below this block fail, as on a node that has pruned old history. */
  prunedBelow = 0n;
  readonly broadcasts: Hex[] = [];
  private oracleRoundId = 1000n;
  private readonly rounds = new Map<number, RoundRecord>();
  private readonly ledgerMap = new Map<string, LedgerEntry>();
  private readonly userEpochs = new Map<string, number[]>();
  private readonly balances = new Map<string, bigint>();
  private readonly receipts = new Map<string, TxReceipt>();
  private readonly signed = new Map<string, Tx>();
  private nonce = 0;
  private readonly betLogs: BetEvent[] = [];
  private externalTxs = 0;

  constructor(startTime = 1_750_000_000) {
    this.time = startTime;
  }

  // ------------------------------------------------------------------------------ simulation controls

  advance(seconds: number): void {
    this.time += seconds;
    this.blockNumber += BigInt(Math.max(1, Math.ceil(seconds)));
  }

  setTime(t: number): void {
    if (t > this.time) this.advance(t - this.time);
  }

  /** genesisStartRound */
  boot(): void {
    this.currentEpoch = 1;
    this.startRound(1);
  }

  round(epoch: number): RoundRecord {
    const r = this.rounds.get(epoch);
    return r ? { ...r } : empty(epoch);
  }

  /**
   * Operator's executeRound at the current round's lock time: lock current, end previous (only within buffer),
   * start next. When called later than lock + buffer the contract would revert; the operator restarts genesis
   * and the unfinished rounds become refundable.
   */
  execute(price: number): void {
    const cur = this.rounds.get(this.currentEpoch)!;
    if (this.time < cur.lockTime!) this.setTime(cur.lockTime! + 1);
    this.price = price;
    this.oracleRoundId++;
    this.blockNumber++;
    if (this.time > cur.lockTime! + this.bufferSeconds) {
      this.currentEpoch++;
      this.startRound(this.currentEpoch);
      return;
    }
    this.rounds.set(this.currentEpoch, {
      ...cur,
      lockPrice: price,
      lockOracleId: this.oracleRoundId.toString(),
    });
    const prev = this.rounds.get(this.currentEpoch - 1);
    if (
      prev &&
      prev.lockOracleId &&
      !prev.oracleCalled &&
      this.time <= prev.closeTime! + this.bufferSeconds
    ) {
      this.endRound(prev, price);
    }
    this.currentEpoch++;
    this.startRound(this.currentEpoch);
  }

  /** A bet from another market participant (pool liquidity). */
  externalBet(from: Address, direction: Direction, value: bigint): void {
    this.requireBettable(this.currentEpoch, from, value);
    const hash = keccak256(stringToHex(`external:${this.externalTxs++}`));
    this.applyBet(from, direction, this.currentEpoch, value, hash);
  }

  fund(address: string, wei: bigint): void {
    this.balances.set(address.toLowerCase(), (this.balances.get(address.toLowerCase()) ?? 0n) + wei);
  }

  private startRound(epoch: number): void {
    this.rounds.set(epoch, {
      ...empty(epoch),
      startTime: this.time,
      lockTime: this.time + this.intervalSeconds,
      closeTime: this.time + 2 * this.intervalSeconds,
    });
  }

  private endRound(r: RoundRecord, price: number): void {
    const total = r.bullAmount + r.bearAmount;
    const treasury = (total * BigInt(this.treasuryFeeBps)) / 10_000n;
    let base = 0n;
    let reward = 0n;
    if (price > r.lockPrice!) {
      base = r.bullAmount;
      reward = total - treasury;
    } else if (price < r.lockPrice!) {
      base = r.bearAmount;
      reward = total - treasury;
    }
    this.rounds.set(r.epoch, {
      ...r,
      closePrice: price,
      closeOracleId: this.oracleRoundId.toString(),
      oracleCalled: true,
      rewardBaseCalAmount: base,
      rewardAmount: reward,
    });
  }

  private requireBettable(epoch: number, from: Address, value: bigint): void {
    const r = this.rounds.get(epoch);
    if (this.paused) throw new Error('execution reverted: Pausable: paused');
    if (!r || epoch !== this.currentEpoch || !(this.time > r.startTime! && this.time < r.lockTime!)) {
      throw new Error('execution reverted: Bet is too early/late');
    }
    if (value < this.minBetWei)
      throw new Error('execution reverted: Bet amount must be greater than minBetAmount');
    if ((this.ledgerMap.get(k(epoch, from))?.amount ?? 0n) > 0n)
      throw new Error('execution reverted: Can only bet once per round');
  }

  private applyBet(from: Address, direction: Direction, epoch: number, value: bigint, txHash: Hex): void {
    const r = this.rounds.get(epoch)!;
    this.rounds.set(epoch, {
      ...r,
      totalAmount: r.totalAmount + value,
      bullAmount: direction === 'BULL' ? r.bullAmount + value : r.bullAmount,
      bearAmount: direction === 'BEAR' ? r.bearAmount + value : r.bearAmount,
    });
    this.ledgerMap.set(k(epoch, from), { position: direction, amount: value, claimed: false });
    const list = this.userEpochs.get(from.toLowerCase()) ?? [];
    list.push(epoch);
    this.userEpochs.set(from.toLowerCase(), list);
    this.betLogs.push({
      epoch,
      direction,
      sender: from,
      amount: value,
      blockNumber: this.blockNumber,
      blockTime: this.time,
      txHash,
      logIndex: this.betLogs.filter((l) => l.blockNumber === this.blockNumber).length,
    });
  }

  isClaimable(epoch: number, a: string): boolean {
    const r = this.rounds.get(epoch);
    const l = this.ledgerMap.get(k(epoch, a));
    if (!r || !l || l.amount === 0n || l.claimed || !r.oracleCalled) return false;
    return (
      (r.closePrice! > r.lockPrice! && l.position === 'BULL') ||
      (r.closePrice! < r.lockPrice! && l.position === 'BEAR')
    );
  }

  isRefundable(epoch: number, a: string): boolean {
    const r = this.rounds.get(epoch);
    const l = this.ledgerMap.get(k(epoch, a));
    return (
      !!r &&
      !!l &&
      l.amount > 0n &&
      !l.claimed &&
      !r.oracleCalled &&
      this.time > r.closeTime! + this.bufferSeconds
    );
  }

  // ------------------------------------------------------------------------------ transactions

  sign(tx: Tx): PreparedTx {
    const hash = keccak256(
      stringToHex(
        `${JSON.stringify(tx, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}:${this.nonce}`,
      ),
    );
    this.signed.set(hash, tx);
    return { hash, serialized: hash, nonce: this.nonce++, gasLimit: 130_000n, gasPrice: GAS_PRICE };
  }

  prepare(tx: Tx): PreparedTx {
    if (tx.kind === 'bet') {
      this.requireBettable(tx.epoch, tx.from, tx.value);
      if ((this.balances.get(tx.from.toLowerCase()) ?? 0n) < tx.value + 130_000n * GAS_PRICE) {
        throw new Error('insufficient funds for gas * price + value');
      }
    } else {
      for (const e of tx.epochs) {
        if (!this.isClaimable(e, tx.from) && !this.isRefundable(e, tx.from))
          throw new Error('execution reverted: Not eligible for claim');
      }
    }
    return this.sign(tx);
  }

  /** Mines a signed transaction (idempotent). */
  accept(hash: Hex): void {
    this.broadcasts.push(hash);
    if (this.receipts.has(hash)) return;
    const tx = this.signed.get(hash)!;
    const from = tx.from.toLowerCase();
    this.blockNumber++;
    let status: 'success' | 'reverted' = 'success';
    if (tx.kind === 'bet') {
      try {
        this.requireBettable(tx.epoch, tx.from, tx.value);
        this.applyBet(tx.from, tx.direction, tx.epoch, tx.value, hash);
        this.balances.set(from, (this.balances.get(from) ?? 0n) - tx.value - GAS_COST);
      } catch {
        status = 'reverted';
        this.balances.set(from, (this.balances.get(from) ?? 0n) - GAS_COST);
      }
    } else {
      const eligible = tx.epochs.every((e) => this.isClaimable(e, tx.from) || this.isRefundable(e, tx.from));
      if (!eligible) status = 'reverted';
      let total = 0n;
      if (eligible) {
        for (const e of tx.epochs) {
          const r = this.rounds.get(e)!;
          const l = this.ledgerMap.get(k(e, tx.from))!;
          total += r.oracleCalled ? (l.amount * r.rewardAmount) / r.rewardBaseCalAmount : l.amount;
          this.ledgerMap.set(k(e, tx.from), { ...l, claimed: true });
        }
      }
      this.balances.set(from, (this.balances.get(from) ?? 0n) + total - GAS_COST);
    }
    this.receipts.set(hash, {
      status,
      blockNumber: this.blockNumber,
      gasUsed: GAS_USED,
      effectiveGasPrice: GAS_PRICE,
    });
  }

  // ------------------------------------------------------------------------------ PredictionReader

  async getParams(): Promise<ContractParams> {
    return {
      intervalSeconds: this.intervalSeconds,
      bufferSeconds: this.bufferSeconds,
      treasuryFeeBps: this.treasuryFeeBps,
      minBetWei: this.minBetWei,
      oracleAddress: ORACLE,
      paused: this.paused,
    };
  }

  async getHead(): Promise<ChainHead> {
    return { blockNumber: this.blockNumber, blockTimestamp: this.time, currentEpoch: this.currentEpoch };
  }

  async getSnapshot(): Promise<ChainSnapshot> {
    if (this.snapshotFailures > 0) {
      this.snapshotFailures--;
      throw new Error('fetch failed');
    }
    const e = this.currentEpoch;
    return {
      blockNumber: this.blockNumber,
      blockTimestamp: this.time,
      currentEpoch: e,
      paused: this.paused,
      rounds: [e, e - 1, e - 2].filter((x) => x > 0).map((x) => this.round(x)),
      oracle: { price: this.price, updatedAt: this.time, roundId: this.oracleRoundId.toString() },
    };
  }

  async getRounds(epochs: readonly number[]): Promise<RoundRecord[]> {
    return epochs.map((e) => this.round(e));
  }

  async getLedger(epoch: number, address: Address): Promise<LedgerEntry> {
    return { ...(this.ledgerMap.get(k(epoch, address)) ?? { position: 'BULL', amount: 0n, claimed: false }) };
  }

  async getUserRoundsLength(address: Address): Promise<number> {
    return this.userEpochs.get(address.toLowerCase())?.length ?? 0;
  }

  async getUserRounds(
    address: Address,
    cursor: number,
    size: number,
  ): Promise<{ rounds: UserRound[]; nextCursor: number }> {
    const list = (this.userEpochs.get(address.toLowerCase()) ?? []).slice(cursor, cursor + size);
    return {
      rounds: list.map((epoch) => ({ epoch, ...this.ledgerMap.get(k(epoch, address))! })),
      nextCursor: cursor + list.length,
    };
  }

  async getClaimStatus(epochs: readonly number[], address: Address) {
    return epochs.map((epoch) => ({
      epoch,
      claimable: this.isClaimable(epoch, address),
      refundable: this.isRefundable(epoch, address),
    }));
  }

  async simulateBet(_direction: Direction, epoch: number, value: bigint, from: Address): Promise<void> {
    if (this.simulateFailures > 0) {
      this.simulateFailures--;
      throw new Error('fetch failed');
    }
    if (this.simulateRevert !== null) {
      const reason = this.simulateRevert;
      this.simulateRevert = null;
      throw new Error(`execution reverted: ${reason}`);
    }
    this.requireBettable(epoch, from, value);
  }

  async getBetEvents(fromBlock: bigint, toBlock: bigint): Promise<BetEvent[]> {
    if (this.logFailures > 0) {
      this.logFailures--;
      throw new Error('fetch failed');
    }
    if (fromBlock < this.prunedBelow) throw new Error('history has been pruned for this block range');
    return this.betLogs
      .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
      .map((l) => ({ ...l }));
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  async getGasPrice(): Promise<bigint> {
    return GAS_PRICE;
  }

  async getReceipt(hash: Hex): Promise<TxReceipt | null> {
    return this.receipts.get(hash) ?? null;
  }
}

export type BroadcastFault = 'reject-insufficient' | 'network-after-send' | 'network-not-sent' | null;

export class FakeWriter implements PredictionWriter {
  fault: BroadcastFault = null;
  readonly sent: Hex[] = [];

  constructor(
    private readonly chain: FakeChain,
    readonly address: Address,
  ) {}

  async prepareBet(direction: Direction, epoch: number, value: bigint): Promise<PreparedTx> {
    return this.chain.prepare({ kind: 'bet', from: this.address, direction, epoch, value });
  }

  async prepareClaim(epochs: readonly number[]): Promise<PreparedTx> {
    return this.chain.prepare({ kind: 'claim', from: this.address, epochs: [...epochs] });
  }

  async broadcast(tx: PreparedTx): Promise<void> {
    const fault = this.fault;
    this.fault = null;
    if (fault === 'reject-insufficient') throw new Error('insufficient funds for gas * price + value');
    if (fault === 'network-not-sent') throw new Error('fetch failed');
    this.sent.push(tx.hash);
    this.chain.accept(tx.hash);
    if (fault === 'network-after-send') throw new Error('fetch failed');
  }

  getReceipt(hash: Hex): Promise<TxReceipt | null> {
    return this.chain.getReceipt(hash);
  }

  waitForReceipt(hash: Hex): Promise<TxReceipt | null> {
    return this.chain.getReceipt(hash);
  }
}
