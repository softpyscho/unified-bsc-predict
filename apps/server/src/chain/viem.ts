/**
 * BSC implementation of the chain ports using viem.
 *  - Reads are batched through Multicall3 and pinned to a single block for consistency.
 *  - RPC endpoints are used through a fallback transport with per-request retries.
 *  - The private key is only held by the local viem account inside ViemPredictionWriter; transactions are signed
 *    locally and never sent to a remote signer.
 */
import type { Direction, RoundRecord } from '@bsc/core';
import { roundFromV2Tuple } from '@bsc/core';
import type { Chain, PublicClient } from 'viem';
import {
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  keccak256,
  toEventSelector,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';
import { chainlinkOracleAbi, predictionV2Abi } from './abis.js';
import type {
  Address,
  BetEvent,
  ChainHead,
  ChainSnapshot,
  ContractParams,
  Hex,
  LedgerEntry,
  OraclePrice,
  PredictionReader,
  PredictionWriter,
  PreparedTx,
  TxReceipt,
  UserRound,
} from './types.js';
import { classifyError } from './types.js';

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const multicallExtrasAbi = [
  {
    type: 'function',
    name: 'getBlockNumber',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'blockNumber', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getCurrentBlockTimestamp',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'timestamp', type: 'uint256' }],
  },
] as const;

/** event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount), and BetBear likewise. */
export const BET_BULL_TOPIC = toEventSelector('BetBull(address,uint256,uint256)');
export const BET_BEAR_TOPIC = toEventSelector('BetBear(address,uint256,uint256)');

interface RawBetLog {
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  /** Returned by nodes that implement it (48.club does); fetched from the block header otherwise. */
  blockTimestamp?: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

/** Multicall chunks: large enough to fit a full sync batch in one RPC request. */
const MULTICALL_BATCH_BYTES = 128_000;

type RoundTuple = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  boolean,
];

export function chainFor(chainId: number): Chain {
  return chainId === 97 ? bscTestnet : bsc;
}

export function createChainClient(rpcUrls: string[], chainId: number): PublicClient {
  const transport = fallback(
    rpcUrls.map((url) => http(url, { timeout: 15_000, retryCount: 2, retryDelay: 400 })),
    { retryCount: 1 },
  );
  return createPublicClient({ chain: chainFor(chainId), transport }) as PublicClient;
}

const position = (p: number): Direction => (p === 0 ? 'BULL' : 'BEAR');

function toRecord(t: RoundTuple): RoundRecord {
  return roundFromV2Tuple({
    epoch: t[0],
    startTimestamp: t[1],
    lockTimestamp: t[2],
    closeTimestamp: t[3],
    lockPrice: t[4],
    closePrice: t[5],
    lockOracleId: t[6],
    closeOracleId: t[7],
    totalAmount: t[8],
    bullAmount: t[9],
    bearAmount: t[10],
    rewardBaseCalAmount: t[11],
    rewardAmount: t[12],
    oracleCalled: t[13],
  });
}

export class ViemPredictionReader implements PredictionReader {
  private oracleAddress: Address | null = null;
  private readonly prediction;
  private readonly logClient: PublicClient;

  constructor(
    readonly client: PublicClient,
    readonly contract: Address,
    /** Client for eth_getLogs; defaults to `client`. */
    logClient?: PublicClient,
  ) {
    this.prediction = { address: contract, abi: predictionV2Abi } as const;
    this.logClient = logClient ?? client;
  }

  async getBetEvents(fromBlock: bigint, toBlock: bigint): Promise<BetEvent[]> {
    const logs = (await this.logClient.request({
      method: 'eth_getLogs',
      params: [
        {
          address: this.contract,
          topics: [[BET_BULL_TOPIC, BET_BEAR_TOPIC]],
          fromBlock: toHex(fromBlock),
          toBlock: toHex(toBlock),
        },
      ],
    })) as unknown as RawBetLog[];
    const times = new Map<string, number>();
    for (const l of logs) {
      if (l.blockTimestamp || times.has(l.blockNumber)) continue;
      const block = await this.logClient.getBlock({ blockNumber: BigInt(l.blockNumber) });
      times.set(l.blockNumber, Number(block.timestamp));
    }
    return logs
      .filter((l) => !l.removed)
      .map((l) => ({
        epoch: Number(BigInt(l.topics[2]!)),
        direction: l.topics[0]!.toLowerCase() === BET_BULL_TOPIC ? ('BULL' as const) : ('BEAR' as const),
        sender: getAddress(`0x${l.topics[1]!.slice(26)}`),
        amount: BigInt(l.data),
        blockNumber: BigInt(l.blockNumber),
        blockTime: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : times.get(l.blockNumber)!,
        txHash: l.transactionHash,
        logIndex: Number(BigInt(l.logIndex)),
      }))
      .sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      );
  }

  async getParams(): Promise<ContractParams> {
    const [interval, buffer, fee, minBet, oracle, paused] = await this.client.multicall({
      allowFailure: false,
      contracts: [
        { ...this.prediction, functionName: 'intervalSeconds' },
        { ...this.prediction, functionName: 'bufferSeconds' },
        { ...this.prediction, functionName: 'treasuryFee' },
        { ...this.prediction, functionName: 'minBetAmount' },
        { ...this.prediction, functionName: 'oracle' },
        { ...this.prediction, functionName: 'paused' },
      ],
    });
    this.oracleAddress = getAddress(oracle);
    return {
      intervalSeconds: Number(interval),
      bufferSeconds: Number(buffer),
      treasuryFeeBps: Number(fee),
      minBetWei: minBet,
      oracleAddress: this.oracleAddress,
      paused,
    };
  }

  async getHead(blockNumber?: bigint): Promise<ChainHead> {
    const [number, timestamp, epoch] = await this.client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [
        { address: MULTICALL3, abi: multicallExtrasAbi, functionName: 'getBlockNumber' },
        { address: MULTICALL3, abi: multicallExtrasAbi, functionName: 'getCurrentBlockTimestamp' },
        { ...this.prediction, functionName: 'currentEpoch' },
      ],
    });
    return { blockNumber: number, blockTimestamp: Number(timestamp), currentEpoch: Number(epoch) };
  }

  async getSnapshot(): Promise<ChainSnapshot> {
    if (!this.oracleAddress) await this.getParams();
    const oracle = this.oracleAddress!;
    const res = await this.client.multicall({
      allowFailure: true,
      contracts: [
        { address: MULTICALL3, abi: multicallExtrasAbi, functionName: 'getBlockNumber' },
        { address: MULTICALL3, abi: multicallExtrasAbi, functionName: 'getCurrentBlockTimestamp' },
        { ...this.prediction, functionName: 'currentEpoch' },
        { ...this.prediction, functionName: 'paused' },
        { address: oracle, abi: chainlinkOracleAbi, functionName: 'latestRoundData' },
      ],
    });
    const [bn, ts, ep, paused, latest] = res;
    if (
      bn.status !== 'success' ||
      ts.status !== 'success' ||
      ep.status !== 'success' ||
      paused.status !== 'success'
    ) {
      throw new Error('snapshot multicall failed');
    }
    const blockNumber = bn.result;
    const currentEpoch = Number(ep.result);
    const epochs = [currentEpoch, currentEpoch - 1, currentEpoch - 2].filter((e) => e > 0);
    const rounds = await this.getRounds(epochs, blockNumber);
    let oraclePrice: OraclePrice | null = null;
    if (latest.status === 'success') {
      const [roundId, answer, , updatedAt] = latest.result;
      oraclePrice = { price: Number(answer), updatedAt: Number(updatedAt), roundId: roundId.toString() };
    }
    return {
      blockNumber,
      blockTimestamp: Number(ts.result),
      currentEpoch,
      paused: paused.result,
      rounds,
      oracle: oraclePrice,
    };
  }

  async getRounds(epochs: readonly number[], blockNumber?: bigint): Promise<RoundRecord[]> {
    if (epochs.length === 0) return [];
    const res = await this.client.multicall({
      allowFailure: false,
      blockNumber,
      batchSize: MULTICALL_BATCH_BYTES,
      contracts: epochs.map((e) => ({
        ...this.prediction,
        functionName: 'rounds' as const,
        args: [BigInt(e)] as const,
      })),
    });
    return (res as unknown as RoundTuple[]).map(toRecord);
  }

  async getLedger(epoch: number, address: Address): Promise<LedgerEntry> {
    const [pos, amount, claimed] = await this.client.readContract({
      ...this.prediction,
      functionName: 'ledger',
      args: [BigInt(epoch), address],
    });
    return { position: position(pos), amount, claimed };
  }

  async getUserRoundsLength(address: Address): Promise<number> {
    const n = await this.client.readContract({
      ...this.prediction,
      functionName: 'getUserRoundsLength',
      args: [address],
    });
    return Number(n);
  }

  async getUserRounds(
    address: Address,
    cursor: number,
    size: number,
  ): Promise<{ rounds: UserRound[]; nextCursor: number }> {
    const [epochs, infos, next] = await this.client.readContract({
      ...this.prediction,
      functionName: 'getUserRounds',
      args: [address, BigInt(cursor), BigInt(size)],
    });
    const rounds = epochs.map((e, i) => {
      const info = infos[i]!;
      return {
        epoch: Number(e),
        position: position(info.position),
        amount: info.amount,
        claimed: info.claimed,
      };
    });
    return { rounds, nextCursor: Number(next) };
  }

  async getClaimStatus(epochs: readonly number[], address: Address) {
    if (epochs.length === 0) return [];
    const res = await this.client.multicall({
      allowFailure: false,
      batchSize: MULTICALL_BATCH_BYTES,
      contracts: epochs.flatMap((e) => [
        { ...this.prediction, functionName: 'claimable' as const, args: [BigInt(e), address] as const },
        { ...this.prediction, functionName: 'refundable' as const, args: [BigInt(e), address] as const },
      ]),
    });
    const flags = res as unknown as boolean[];
    return epochs.map((epoch, i) => ({ epoch, claimable: flags[i * 2]!, refundable: flags[i * 2 + 1]! }));
  }

  getBalance(address: Address): Promise<bigint> {
    return this.client.getBalance({ address });
  }

  getGasPrice(): Promise<bigint> {
    return this.client.getGasPrice();
  }

  async getReceipt(hash: Hex): Promise<TxReceipt | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return {
        status: r.status,
        blockNumber: r.blockNumber,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
      };
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
  }
}

export class ViemPredictionWriter implements PredictionWriter {
  readonly address: Address;
  private readonly account;

  constructor(
    private readonly reader: ViemPredictionReader,
    privateKey: Hex,
    private readonly chainId: number,
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  private get client(): PublicClient {
    return this.reader.client;
  }

  async prepareBet(direction: Direction, epoch: number, value: bigint): Promise<PreparedTx> {
    const functionName = direction === 'BULL' ? 'betBull' : 'betBear';
    await this.client.simulateContract({
      account: this.account,
      address: this.reader.contract,
      abi: predictionV2Abi,
      functionName,
      args: [BigInt(epoch)],
      value,
    });
    const data = encodeFunctionData({ abi: predictionV2Abi, functionName, args: [BigInt(epoch)] });
    return this.sign(data, value);
  }

  async prepareClaim(epochs: readonly number[]): Promise<PreparedTx> {
    const args = [epochs.map((e) => BigInt(e))] as const;
    await this.client.simulateContract({
      account: this.account,
      address: this.reader.contract,
      abi: predictionV2Abi,
      functionName: 'claim',
      args,
    });
    return this.sign(encodeFunctionData({ abi: predictionV2Abi, functionName: 'claim', args }), 0n);
  }

  private async sign(data: Hex, value: bigint): Promise<PreparedTx> {
    const to = this.reader.contract;
    const [gas, gasPrice, nonce] = await Promise.all([
      this.client.estimateGas({ account: this.account, to, data, value }),
      this.client.getGasPrice(),
      this.client.getTransactionCount({ address: this.address, blockTag: 'pending' }),
    ]);
    const gasLimit = (gas * 13n) / 10n;
    const serialized = await this.account.signTransaction({
      chainId: this.chainId,
      type: 'legacy',
      to,
      data,
      value,
      gas: gasLimit,
      gasPrice,
      nonce,
    });
    return { hash: keccak256(serialized), serialized, nonce, gasLimit, gasPrice };
  }

  async broadcast(tx: PreparedTx): Promise<void> {
    try {
      await this.client.sendRawTransaction({ serializedTransaction: tx.serialized });
    } catch (err) {
      const c = classifyError(err);
      if (c.errorClass === 'ALREADY_KNOWN') return;
      if (c.errorClass === 'NONCE' && (await this.reader.getReceipt(tx.hash))) return;
      throw c;
    }
  }

  getReceipt(hash: Hex): Promise<TxReceipt | null> {
    return this.reader.getReceipt(hash);
  }

  async waitForReceipt(hash: Hex, timeoutMs: number): Promise<TxReceipt | null> {
    try {
      const r = await this.client.waitForTransactionReceipt({
        hash,
        timeout: timeoutMs,
        pollingInterval: 1_000,
      });
      return {
        status: r.status,
        blockNumber: r.blockNumber,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
      };
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) return null;
      throw err;
    }
  }
}
