/**
 * Phase 0 viability study for PancakeSwap Prediction V2 (BNB/USD): is there any edge after all costs?
 * Read-only against the app database; writes only data/phase0/ and docs/VIABILITY_REPORT.md.
 *
 *   npx tsx scripts/viability/phase0.ts --fetch   fetch BetBull/BetBear logs (cached per chunk, resumable), then analyse
 *   npx tsx scripts/viability/phase0.ts           analyse with whatever logs are already cached
 *
 * PHASE0_LOG_RPC defaults to https://rpc-bsc.48.club: the only free endpoint found that serves historical
 * eth_getLogs with block timestamps (BNB Chain's dataseeds reject eth_getLogs; PublicNode serves only recent
 * blocks). It prunes old blocks, so the decision-time pool sample is bounded by its retention window.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, getAddress, http } from 'viem';
import { bsc } from 'viem/chains';
import { predictionV2Abi } from '../../apps/server/src/chain/abis.js';
import type { Direction, RoundOutcome } from '../../packages/core/src/index.js';
import {
  benjaminiHochberg,
  deriveOutcome,
  meanInterval,
  pearson,
  proportionZTest,
  quantile,
  roundFromV2Tuple,
  simulatedPayout,
  wilsonInterval,
} from '../../packages/core/src/index.js';

const CONTRACT = getAddress('0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA');
const LOG_RPC = process.env.PHASE0_LOG_RPC ?? 'https://rpc-bsc.48.club';
const CALL_RPC = process.env.PHASE0_CALL_RPC ?? 'https://bsc-dataseed.bnbchain.org';
const DB_PATH = 'data/bsc-predict.db';
const OUT_DIR = 'data/phase0';
const EVENTS_DIR = `${OUT_DIR}/events`;
const REPORT_PATH = 'docs/VIABILITY_REPORT.md';
const TOPIC_BULL = '0x438122d8cff518d18388099a5181f0d17a12b4f1b55faedf6e4a6acee0060c12';
const TOPIC_BEAR = '0x0d8c1fe3e67ab767116a81f122b83c2557a8c2564019cb7c4f83de1aeb1f1f0d';
const TOPIC_CLAIM = '0x34fcbac0073d7c3d388e51312faf357774904998eeb8fca628b9e6f65ee1cbf7';
const CHUNK_BLOCKS = 5000;
const STAKE = 10n ** 16n; // 0.01 BNB: the configured minimum stake
const RECENT_ROUNDS = 25_000;
const TRAIN_FRACTION = 0.7;
const DECISION_OFFSETS = [30, 10] as const;
const FETCH = process.argv.includes('--fetch');

const bnb = (wei: bigint | number) => Number(wei) / 1e18;
const hex = (n: number) => `0x${n.toString(16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isDecided = (o: RoundOutcome): o is Direction => o === 'BULL' || o === 'BEAR';

// ------------------------------------------------------------------------------------------------ plumbing

async function rpc<T>(method: string, params: unknown[], attempts = 4, url = LOG_RPC): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(body.error.message);
      return body.result as T;
    } catch (e) {
      if (i >= attempts) throw e;
      await sleep(500 * 2 ** i);
    }
  }
}

async function parallel<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// ------------------------------------------------------------------------------------------------ data

interface Round {
  epoch: number;
  lockTime: number;
  total: bigint;
  bull: bigint;
  bear: bigint;
  reward: bigint;
  rewardBase: bigint;
  outcome: RoundOutcome;
  source: string;
  feeBps: number;
}

interface PoolEvent {
  epoch: number;
  ts: number;
  side: Direction;
  amount: string;
  block: number;
  tx: string;
}

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
  transactionHash: string;
}

interface Gas {
  bet: bigint;
  claim: bigint;
  claimPerEpoch: bigint;
  gasPriceGwei: number | null;
  betSamples: number;
  claimSamples: number;
}

interface Hypothesis {
  id: string;
  family: string;
  label: string;
  n: number;
  estimate: number;
  baseline: number;
  pRaw: number;
  pAdj?: number;
}

function loadRounds(defaultFeeBps: number): Round[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT epoch, lock_time, total_amount, bull_amount, bear_amount, reward_amount, reward_base_cal_amount,
              outcome, source
         FROM rounds_v
        WHERE market_id = 1 AND is_final = 1 AND outcome IS NOT NULL AND lock_time IS NOT NULL
        ORDER BY epoch`,
    )
    .all() as Record<string, string | number>[];
  db.close();
  return rows.map((r) => {
    const total = BigInt(r.total_amount!);
    const reward = BigInt(r.reward_amount!);
    const outcome = r.outcome as RoundOutcome;
    const feeBps =
      isDecided(outcome) && total > 0n && reward > 0n
        ? Math.round((Number(total - reward) * 10_000) / Number(total))
        : defaultFeeBps;
    return {
      epoch: Number(r.epoch),
      lockTime: Number(r.lock_time),
      total,
      bull: BigInt(r.bull_amount!),
      bear: BigInt(r.bear_amount!),
      reward,
      rewardBase: BigInt(r.reward_base_cal_amount!),
      outcome,
      source: String(r.source),
      feeBps,
    };
  });
}

function chainClient() {
  return createPublicClient({ chain: bsc, transport: http(CALL_RPC, { timeout: 20_000, retryCount: 3 }) });
}

async function readParams() {
  const client = chainClient();
  const read = (functionName: string) =>
    client.readContract({
      address: CONTRACT,
      abi: predictionV2Abi,
      functionName,
    } as never) as Promise<unknown>;
  const names = [
    'treasuryFee',
    'minBetAmount',
    'intervalSeconds',
    'bufferSeconds',
    'currentEpoch',
    'paused',
    'oracle',
  ];
  const [fee, minBet, interval, buffer, epoch, paused, oracle] = await Promise.all(names.map(read));
  return {
    treasuryFeeBps: Number(fee),
    minBetBnb: bnb(minBet as bigint),
    intervalSeconds: Number(interval),
    bufferSeconds: Number(buffer),
    currentEpoch: Number(epoch),
    paused: Boolean(paused),
    oracle: String(oracle),
    readAt: new Date().toISOString(),
  };
}

/** Re-reads a deterministic sample of stored rounds from the contract and diffs every settlement field. */
async function verifyAgainstChain(rounds: readonly Round[]) {
  const client = chainClient();
  const pick = (list: readonly Round[], count: number) => {
    const step = Math.max(1, Math.floor(list.length / count));
    return list.filter((_, i) => i % step === 0).slice(0, count);
  };
  const recent = pick(rounds.slice(-RECENT_ROUNDS), 200);
  const archive = pick(
    rounds.filter((r) => r.source !== 'CHAIN'),
    200,
  );
  const check = async (sample: readonly Round[]) => {
    const mismatches: number[] = [];
    for (let i = 0; i < sample.length; i += 50) {
      const batch = sample.slice(i, i + 50);
      const tuples = (await client.multicall({
        allowFailure: false,
        contracts: batch.map((r) => ({
          address: CONTRACT,
          abi: predictionV2Abi,
          functionName: 'rounds',
          args: [BigInt(r.epoch)],
        })),
      } as never)) as unknown as readonly (readonly unknown[])[];
      tuples.forEach((t, j) => {
        const c = roundFromV2Tuple({
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
        } as never);
        const d = batch[j]!;
        const outcome = deriveOutcome(c, c.oracleCalled ? 'ENDED' : 'CANCELLED');
        if (
          c.totalAmount !== d.total ||
          c.bullAmount !== d.bull ||
          c.bearAmount !== d.bear ||
          c.rewardAmount !== d.reward ||
          c.lockTime !== d.lockTime ||
          outcome !== d.outcome
        )
          mismatches.push(d.epoch);
      });
    }
    return { checked: sample.length, mismatches };
  };
  return { recent: await check(recent), archive: await check(archive) };
}

// ------------------------------------------------------------------------------------------------ events

const chunkFile = (from: number) => `${EVENTS_DIR}/${from}.json`;

function parseLog(l: RawLog): PoolEvent {
  return {
    epoch: Number(BigInt(l.topics[2]!)),
    ts: Number(BigInt(l.blockTimestamp ?? '0x0')),
    side: l.topics[0] === TOPIC_BULL ? 'BULL' : 'BEAR',
    amount: BigInt(l.data).toString(),
    block: Number(BigInt(l.blockNumber)),
    tx: l.transactionHash,
  };
}

/** Oldest block the log RPC still serves (it prunes), found by binary search, plus a safety margin. */
async function earliestServedBlock(head: number): Promise<number> {
  const served = async (b: number) => {
    try {
      await rpc(
        'eth_getLogs',
        [{ address: CONTRACT, topics: [[TOPIC_BULL]], fromBlock: hex(b), toBlock: hex(b + 10) }],
        2,
      );
      return true;
    } catch {
      return false;
    }
  };
  let ok = head - 200_000;
  let bad = head - 12_000_000;
  if (!(await served(ok))) throw new Error(`${LOG_RPC} serves less than ~1 day of logs`);
  while (ok - bad > 20_000) {
    const mid = Math.floor((ok + bad) / 2);
    if (await served(mid)) ok = mid;
    else bad = mid;
  }
  return ok + 100_000; // the node keeps pruning while we fetch; start comfortably inside the window
}

async function fetchEvents(): Promise<void> {
  mkdirSync(EVENTS_DIR, { recursive: true });
  const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])));
  const start = await earliestServedBlock(head);
  const first = Math.ceil(start / CHUNK_BLOCKS) * CHUNK_BLOCKS;
  const chunks: number[] = [];
  for (let b = first; b + CHUNK_BLOCKS - 1 <= head; b += CHUNK_BLOCKS)
    if (!existsSync(chunkFile(b))) chunks.push(b);
  console.log(
    `fetching ${chunks.length} chunks of ${CHUNK_BLOCKS} blocks (${first} → ${head}) from ${LOG_RPC}`,
  );
  let done = 0;
  let failed = 0;
  await parallel(chunks, 4, async (from) => {
    try {
      const logs = await rpc<RawLog[]>('eth_getLogs', [
        {
          address: CONTRACT,
          topics: [[TOPIC_BULL, TOPIC_BEAR]],
          fromBlock: hex(from),
          toBlock: hex(from + CHUNK_BLOCKS - 1),
        },
      ]);
      writeFileSync(chunkFile(from), JSON.stringify(logs.map(parseLog)));
    } catch (e) {
      failed++;
      console.warn(`  chunk ${from} failed: ${(e as Error).message}`);
    }
    if (++done % 50 === 0) console.log(`  ${done}/${chunks.length}`);
  });
  console.log(`fetched ${done - failed}/${chunks.length} chunks (${failed} failed; re-run to retry)`);
}

function loadEvents(): Map<number, PoolEvent[]> {
  const byEpoch = new Map<number, PoolEvent[]>();
  if (!existsSync(EVENTS_DIR)) return byEpoch;
  for (const f of readdirSync(EVENTS_DIR)) {
    for (const e of JSON.parse(readFileSync(`${EVENTS_DIR}/${f}`, 'utf8')) as PoolEvent[]) {
      const list = byEpoch.get(e.epoch);
      if (list) list.push(e);
      else byEpoch.set(e.epoch, [e]);
    }
  }
  return byEpoch;
}

// ------------------------------------------------------------------------------------------------ gas

const medianBig = (xs: readonly bigint[]) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s.length ? s[Math.floor(s.length / 2)]! : null;
};

async function measureGas(events: Map<number, PoolEvent[]>): Promise<Gas> {
  type Receipt = { gasUsed: string; effectiveGasPrice: string };
  const cost = (r: Receipt) => BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
  const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])));

  let betTxs = [
    ...new Set(
      [...events.values()]
        .flat()
        .sort((a, b) => b.block - a.block)
        .map((e) => e.tx),
    ),
  ].slice(0, 300);
  if (betTxs.length === 0) {
    const logs = await rpc<RawLog[]>('eth_getLogs', [
      {
        address: CONTRACT,
        topics: [[TOPIC_BULL, TOPIC_BEAR]],
        fromBlock: hex(head - CHUNK_BLOCKS),
        toBlock: hex(head),
      },
    ]);
    betTxs = [...new Set(logs.map((l) => l.transactionHash))].slice(0, 300);
  }
  const claimsPerTx = new Map<string, number>();
  for (let from = head - 4 * CHUNK_BLOCKS; from < head; from += CHUNK_BLOCKS) {
    const logs = await rpc<RawLog[]>('eth_getLogs', [
      {
        address: CONTRACT,
        topics: [[TOPIC_CLAIM]],
        fromBlock: hex(from),
        toBlock: hex(Math.min(head, from + CHUNK_BLOCKS - 1)),
      },
    ]);
    for (const l of logs) claimsPerTx.set(l.transactionHash, (claimsPerTx.get(l.transactionHash) ?? 0) + 1);
  }
  const claimTxs = [...claimsPerTx.keys()].slice(0, 150);

  const betCosts: bigint[] = [];
  const prices: number[] = [];
  const claimCosts: bigint[] = [];
  const claimPerEpoch: bigint[] = [];
  await parallel(betTxs, 4, async (h) => {
    const r = await rpc<Receipt>('eth_getTransactionReceipt', [h]).catch(() => null);
    if (!r) return;
    betCosts.push(cost(r));
    prices.push(Number(BigInt(r.effectiveGasPrice)) / 1e9);
  });
  await parallel(claimTxs, 4, async (h) => {
    const r = await rpc<Receipt>('eth_getTransactionReceipt', [h]).catch(() => null);
    if (!r) return;
    claimCosts.push(cost(r));
    claimPerEpoch.push(cost(r) / BigInt(claimsPerTx.get(h) ?? 1));
  });
  prices.sort((a, b) => a - b);
  return {
    bet: medianBig(betCosts) ?? 10n ** 13n,
    claim: medianBig(claimCosts) ?? 10n ** 13n,
    claimPerEpoch: medianBig(claimPerEpoch) ?? 10n ** 13n,
    gasPriceGwei: quantile(prices, 0.5),
    betSamples: betCosts.length,
    claimSamples: claimCosts.length,
  };
}

// ------------------------------------------------------------------------------------------------ bet evaluation

interface BetStats {
  bets: number;
  hitRate: number | null;
  hitCi: { low: number; high: number } | null;
  roi: number | null;
  roiCi: { low: number; high: number } | null;
  meanWinMultiplier: number | null;
  breakEven: number | null;
  clears: boolean;
}

/** Break-even hit rate for a stake s: p* = (s + gasBet) / (s·M − gasClaim). */
function breakEven(stake: bigint, multiplier: number, gas: Gas): number {
  const s = bnb(stake);
  return (s + bnb(gas.bet)) / (s * multiplier - bnb(gas.claim));
}

/** Realised result of betting `side` with STAKE: own stake added to the final pool, all gas charged. */
function summarize(bets: readonly { r: Round; side: Direction }[], gas: Gas): BetStats {
  const returns: number[] = [];
  const winMultipliers: number[] = [];
  let resolved = 0;
  let wins = 0;
  for (const { r, side } of bets) {
    const payout = simulatedPayout(
      { bullAmount: r.bull, bearAmount: r.bear },
      r.outcome,
      side,
      STAKE,
      r.feeBps,
    );
    const net = payout - STAKE - gas.bet - (payout > 0n ? gas.claim : 0n);
    returns.push(bnb(net) / bnb(STAKE));
    if (r.outcome === 'CANCELLED') continue;
    resolved++;
    if (payout > 0n) {
      wins++;
      winMultipliers.push(bnb(payout) / bnb(STAKE));
    }
  }
  const roi = meanInterval(returns);
  const m = winMultipliers.length ? winMultipliers.reduce((a, b) => a + b, 0) / winMultipliers.length : null;
  return {
    bets: bets.length,
    hitRate: resolved ? wins / resolved : null,
    hitCi: wilsonInterval(wins, resolved),
    roi: roi?.mean ?? null,
    roiCi: roi ? { low: roi.low, high: roi.high } : null,
    meanWinMultiplier: m,
    breakEven: m ? breakEven(STAKE, m, gas) : null,
    clears: roi !== null && roi.low > 0,
  };
}

// ------------------------------------------------------------------------------------------------ analyses

function outcomeDistribution(rounds: readonly Round[]) {
  const counts: Record<RoundOutcome, number> = { BULL: 0, BEAR: 0, TIE: 0, CANCELLED: 0 };
  for (const r of rounds) counts[r.outcome]++;
  const n = rounds.length;
  const decided = counts.BULL + counts.BEAR;
  return {
    n,
    rows: (Object.keys(counts) as RoundOutcome[]).map((k) => ({
      outcome: k,
      count: counts[k],
      share: counts[k] / n,
      ci: wilsonInterval(counts[k], n),
    })),
    bullGivenDecided: counts.BULL / decided,
    bullGivenDecidedCi: wilsonInterval(counts.BULL, decided),
    bullTest: proportionZTest(counts.BULL, decided, 0.5),
    decided,
  };
}

function multiplierStats(rounds: readonly Round[]) {
  const mBull: number[] = [];
  const mBear: number[] = [];
  const winner: number[] = [];
  let emptySide = 0;
  let emptyWinner = 0;
  let houseTake = 0n;
  let totalPool = 0n;
  const perRoundTake: number[] = [];
  for (const r of rounds) {
    totalPool += r.total;
    const f = 1 - r.feeBps / 10_000;
    let take = 0n;
    if (r.outcome === 'TIE') take = r.total;
    else if (isDecided(r.outcome)) {
      take = r.total - r.reward;
      if (r.rewardBase === 0n) {
        take = r.total; // nobody backed the winning side: the whole pot is unclaimable
        emptyWinner++;
      } else winner.push(bnb(r.reward) / bnb(r.rewardBase));
    }
    houseTake += take;
    if (r.total > 0n) perRoundTake.push(bnb(take) / bnb(r.total));
    if (r.bull === 0n || r.bear === 0n) {
      emptySide++;
      continue;
    }
    if (r.outcome === 'CANCELLED') continue;
    mBull.push((bnb(r.total) * f) / bnb(r.bull));
    mBear.push((bnb(r.total) * f) / bnb(r.bear));
  }
  const dist = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return {
      n: s.length,
      mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
      p5: quantile(s, 0.05),
      p25: quantile(s, 0.25),
      p50: quantile(s, 0.5),
      p75: quantile(s, 0.75),
      p95: quantile(s, 0.95),
    };
  };
  const takeSorted = [...perRoundTake].sort((a, b) => a - b);
  return {
    bull: dist(mBull),
    bear: dist(mBear),
    winner: dist(winner),
    emptySide,
    emptyWinner,
    poolWeightedTake: bnb(houseTake) / bnb(totalPool),
    meanRoundTake: perRoundTake.reduce((a, b) => a + b, 0) / (perRoundTake.length || 1),
    roundsWithFullTake: perRoundTake.filter((t) => t > 0.99).length,
    roundsWithZeroTake: perRoundTake.filter((t) => t === 0).length,
    medianTake: quantile(takeSorted, 0.5),
    totalPoolBnb: bnb(totalPool),
    houseTakeBnb: bnb(houseTake),
  };
}

function controls(rounds: readonly Round[], gas: Gas) {
  const rand = lcg(20260914);
  return {
    alwaysBull: summarize(
      rounds.map((r) => ({ r, side: 'BULL' as Direction })),
      gas,
    ),
    alwaysBear: summarize(
      rounds.map((r) => ({ r, side: 'BEAR' as Direction })),
      gas,
    ),
    random: summarize(
      rounds.map((r) => ({ r, side: (rand() < 0.5 ? 'BULL' : 'BEAR') as Direction })),
      gas,
    ),
  };
}

interface ContextStat {
  lag: number;
  context: string;
  trainN: number;
  trainBull: number;
  testN: number;
  testBull: number;
  predicted: Direction;
  hypothesisId: string;
  test: BetStats | null;
}

/**
 * Conditional outcome probabilities given the last k decided outcomes. lag 1 is the classic transition matrix
 * (uses round n−1, which is still running when round n takes bets, so it is NOT tradable); lag 2 uses only
 * rounds ≤ n−2, which is what a bettor actually knows. Ties and cancellations are skipped in the sequence.
 */
function sequenceAnalysis(rounds: readonly Round[], gas: Gas, hyps: Hypothesis[]) {
  const split = Math.floor(rounds.length * TRAIN_FRACTION);
  const trainDecided = rounds.slice(0, split).filter((r) => isDecided(r.outcome));
  const p0 = trainDecided.filter((r) => r.outcome === 'BULL').length / trainDecided.length;
  const acc = new Map<
    string,
    {
      lag: number;
      context: string;
      trainN: number;
      trainBull: number;
      testN: number;
      testBull: number;
      testRounds: Round[];
    }
  >();
  for (const lag of [1, 2]) {
    const hist: string[] = [];
    let p = 0;
    for (let j = 0; j < rounds.length; j++) {
      const r = rounds[j]!;
      while (p < j && rounds[p]!.epoch <= r.epoch - lag) {
        const o = rounds[p]!.outcome;
        if (isDecided(o)) hist.push(o === 'BULL' ? 'U' : 'D');
        p++;
      }
      for (let k = 1; k <= 4 && k <= hist.length; k++) {
        const context = hist.slice(-k).join('');
        const key = `${lag}:${context}`;
        let s = acc.get(key);
        if (!s)
          acc.set(
            key,
            (s = { lag, context, trainN: 0, trainBull: 0, testN: 0, testBull: 0, testRounds: [] }),
          );
        const bull = r.outcome === 'BULL' ? 1 : 0;
        if (j < split) {
          if (isDecided(r.outcome)) {
            s.trainN++;
            s.trainBull += bull;
          }
        } else {
          if (isDecided(r.outcome)) {
            s.testN++;
            s.testBull += bull;
          }
          if (lag === 2) s.testRounds.push(r);
        }
      }
    }
  }
  const out: ContextStat[] = [];
  for (const s of [...acc.values()].sort(
    (a, b) => a.lag - b.lag || a.context.length - b.context.length || a.context.localeCompare(b.context),
  )) {
    const id = `seq-lag${s.lag}-${s.context}`;
    const t = proportionZTest(s.trainBull, s.trainN, p0);
    if (t) {
      hyps.push({
        id,
        family: s.lag === 1 ? 'sequence (lag 1, statistical)' : 'sequence (lag 2, tradable)',
        label: `P(BULL | last ${s.context.length} = ${s.context})`,
        n: s.trainN,
        estimate: s.trainBull / s.trainN,
        baseline: p0,
        pRaw: t.pValue,
      });
    }
    const predicted: Direction = s.trainBull / s.trainN > 0.5 ? 'BULL' : 'BEAR';
    out.push({
      lag: s.lag,
      context: s.context,
      trainN: s.trainN,
      trainBull: s.trainBull,
      testN: s.testN,
      testBull: s.testBull,
      predicted,
      hypothesisId: id,
      test:
        s.lag === 2
          ? summarize(
              s.testRounds.map((r) => ({ r, side: predicted })),
              gas,
            )
          : null,
    });
  }
  return { p0Train: p0, split, contexts: out };
}

function hourAnalysis(rounds: readonly Round[], gas: Gas, hyps: Hypothesis[]) {
  const split = Math.floor(rounds.length * TRAIN_FRACTION);
  const hours = Array.from({ length: 24 }, () => ({ trainN: 0, trainBull: 0, test: [] as Round[] }));
  let decided = 0;
  let bulls = 0;
  rounds.forEach((r, j) => {
    const h = hours[new Date(r.lockTime * 1000).getUTCHours()]!;
    if (j < split) {
      if (!isDecided(r.outcome)) return;
      h.trainN++;
      decided++;
      if (r.outcome === 'BULL') {
        h.trainBull++;
        bulls++;
      }
    } else h.test.push(r);
  });
  const p0 = bulls / decided;
  return hours.map((h, hour) => {
    const t = proportionZTest(h.trainBull, h.trainN, p0)!;
    const id = `hour-${hour}`;
    hyps.push({
      id,
      family: 'time of day (UTC)',
      label: `P(BULL | hour ${hour})`,
      n: h.trainN,
      estimate: h.trainBull / h.trainN,
      baseline: p0,
      pRaw: t.pValue,
    });
    const predicted: Direction = h.trainBull / h.trainN > 0.5 ? 'BULL' : 'BEAR';
    return {
      hour,
      trainN: h.trainN,
      pBull: h.trainBull / h.trainN,
      predicted,
      hypothesisId: id,
      test: summarize(
        h.test.map((r) => ({ r, side: predicted })),
        gas,
      ),
    };
  });
}

function poolAnalysis(
  rounds: readonly Round[],
  events: Map<number, PoolEvent[]>,
  gas: Gas,
  hyps: Hypothesis[],
) {
  const byEpoch = new Map(rounds.map((r) => [r.epoch, r]));
  const sample: { r: Round; at: { off: number; bull: bigint; bear: bigint }[] }[] = [];
  let candidates = 0;
  for (const [epoch, evs] of events) {
    const r = byEpoch.get(epoch);
    if (!r) continue;
    candidates++;
    let b = 0n;
    let d = 0n;
    for (const e of evs) {
      if (e.side === 'BULL') b += BigInt(e.amount);
      else d += BigInt(e.amount);
    }
    if (b !== r.bull || d !== r.bear) continue; // incomplete window (pruned or failed chunk): unusable
    const at = DECISION_OFFSETS.map((off) => {
      let db = 0n;
      let dd = 0n;
      for (const e of evs) {
        if (e.ts > r.lockTime - off) continue;
        if (e.side === 'BULL') db += BigInt(e.amount);
        else dd += BigInt(e.amount);
      }
      return { off, bull: db, bear: dd };
    });
    sample.push({ r, at });
  }
  sample.sort((a, b) => a.r.epoch - b.r.epoch);
  if (sample.length === 0) return null;
  const decided = sample.filter((s) => isDecided(s.r.outcome));
  const p0 = decided.filter((s) => s.r.outcome === 'BULL').length / decided.length;
  const split = Math.floor(sample.length * TRAIN_FRACTION);
  const rand = lcg(7);

  const perOffset = DECISION_OFFSETS.map((off, oi) => {
    const lateShares: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const finalXs: number[] = [];
    const slipAll: number[] = [];
    const slipLong: number[] = [];
    const slipFav: number[] = [];
    const longBets: { r: Round; side: Direction }[] = [];
    const favBets: { r: Round; side: Direction }[] = [];
    const longOos: { r: Round; side: Direction }[] = [];
    const favOos: { r: Round; side: Direction }[] = [];
    sample.forEach(({ r, at }, idx) => {
      const a = at[oi]!;
      const dTotal = a.bull + a.bear;
      if (r.total > 0n) lateShares.push(bnb(r.total - dTotal) / bnb(r.total));
      if (dTotal === 0n) return;
      const f = 1 - r.feeBps / 10_000;
      const share = bnb(a.bull) / bnb(dTotal);
      if (isDecided(r.outcome)) {
        xs.push(share);
        ys.push(r.outcome === 'BULL' ? 1 : 0);
        finalXs.push(bnb(r.bull) / bnb(r.total));
      }
      const mDec = (side: bigint) => (side > 0n ? (bnb(dTotal) * f) / bnb(side) : null);
      const mReal = (side: bigint) => (side > 0n ? (bnb(r.total) * f) / bnb(side) : null);
      const decBull = mDec(a.bull);
      const decBear = mDec(a.bear);
      const realBull = mReal(r.bull);
      const realBear = mReal(r.bear);
      if (decBull !== null && realBull !== null) slipAll.push(realBull - decBull);
      if (decBear !== null && realBear !== null) slipAll.push(realBear - decBear);
      const long: Direction = a.bull <= a.bear ? 'BULL' : 'BEAR';
      const fav: Direction = long === 'BULL' ? 'BEAR' : 'BULL';
      const pair = (side: Direction) => (side === 'BULL' ? [decBull, realBull] : [decBear, realBear]);
      const [ld, lr] = pair(long);
      const [fd, fr] = pair(fav);
      if (ld != null && lr != null) slipLong.push(lr - ld);
      if (fd != null && fr != null) slipFav.push(fr - fd);
      longBets.push({ r, side: long });
      favBets.push({ r, side: fav });
      if (idx >= split) {
        longOos.push({ r, side: long });
        favOos.push({ r, side: fav });
      }
    });
    const corr = pearson(xs, ys);
    if (corr) {
      hyps.push({
        id: `pool-corr-T${off}`,
        family: 'decision-time pool imbalance',
        label: `corr(bull share at T−${off}s, BULL)`,
        n: corr.n,
        estimate: corr.r,
        baseline: 0,
        pRaw: corr.pValue,
      });
    }
    const sortedX = [...xs].sort((a, b) => a - b);
    const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(sortedX, q)!);
    const buckets = Array.from({ length: 5 }, () => ({ n: 0, bull: 0 }));
    xs.forEach((x, i) => {
      const b = buckets[cuts.filter((c) => x > c).length]!;
      b.n++;
      b.bull += ys[i]!;
    });
    const quintiles = buckets.map((b, qi) => {
      const t = proportionZTest(b.bull, b.n, p0);
      const id = `pool-q${qi + 1}-T${off}`;
      if (t)
        hyps.push({
          id,
          family: 'decision-time pool imbalance',
          label: `P(BULL | bull-share quintile ${qi + 1} at T−${off}s)`,
          n: b.n,
          estimate: b.bull / b.n,
          baseline: p0,
          pRaw: t.pValue,
        });
      return {
        quintile: qi + 1,
        n: b.n,
        pBull: b.n ? b.bull / b.n : null,
        ci: wilsonInterval(b.bull, b.n),
        hypothesisId: id,
      };
    });
    const stats = (xs2: number[]) => {
      const s = [...xs2].sort((a, b) => a - b);
      return { n: s.length, mean: meanInterval(s), median: quantile(s, 0.5) };
    };
    return {
      off,
      lateFlow: stats(lateShares),
      correlation: corr,
      finalShareCorrelation: pearson(finalXs, ys),
      quintiles,
      slippage: { allSides: stats(slipAll), longOddsSide: stats(slipLong), favouriteSide: stats(slipFav) },
      longOdds: summarize(longBets, gas),
      favourite: summarize(favBets, gas),
      longOddsOos: summarize(longOos, gas),
      favouriteOos: summarize(favOos, gas),
    };
  });
  return {
    candidates,
    sampleRounds: sample.length,
    fromEpoch: sample[0]!.r.epoch,
    toEpoch: sample.at(-1)!.r.epoch,
    p0,
    perOffset,
    controls: {
      alwaysBull: summarize(
        sample.map((s) => ({ r: s.r, side: 'BULL' as Direction })),
        gas,
      ),
      random: summarize(
        sample.map((s) => ({ r: s.r, side: (rand() < 0.5 ? 'BULL' : 'BEAR') as Direction })),
        gas,
      ),
    },
  };
}

// ------------------------------------------------------------------------------------------------ report

const pct = (x: number | null | undefined, dp = 2) =>
  x == null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(dp)}%`;
const fx = (x: number | null | undefined, dp = 3) =>
  x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(dp);
const pv = (p: number | undefined) =>
  p === undefined ? 'n/a' : p < 1e-4 ? p.toExponential(1) : p.toFixed(4);
const ci = (c: { low: number; high: number } | null | undefined, dp = 2) =>
  c ? `${pct(c.low, dp)} to ${pct(c.high, dp)}` : 'n/a';
const table = (head: string[], rows: (string | number)[][]) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
const betRow = (name: string, s: BetStats) => [
  name,
  s.bets.toLocaleString('en-US'),
  pct(s.hitRate),
  fx(s.meanWinMultiplier),
  pct(s.breakEven),
  pct(s.roi),
  ci(s.roiCi),
  s.clears ? '**yes**' : 'no',
];
const BET_HEAD = [
  'Rule',
  'Bets',
  'Hit rate',
  'Mean win ×',
  'Break-even hit rate',
  'Net ROI',
  'ROI 95% CI',
  'Edge?',
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('reading contract parameters…');
  const params = await readParams();
  const rounds = loadRounds(params.treasuryFeeBps);
  const recent = rounds.slice(-RECENT_ROUNDS);
  console.log(`${rounds.length} final rounds (${recent.length} recent); verifying against chain…`);
  const verification = await verifyAgainstChain(rounds);
  if (FETCH) await fetchEvents();
  const events = loadEvents();
  console.log(`${events.size} epochs with bet events cached; measuring gas…`);
  const gas = await measureGas(events);

  const hyps: Hypothesis[] = [];
  const full = outcomeDistribution(rounds);
  const rec = outcomeDistribution(recent);
  if (full.bullTest)
    hyps.push({
      id: 'bull-bias-full',
      family: 'baseline',
      label: 'P(BULL | decided) ≠ 0.5 (full history)',
      n: full.decided,
      estimate: full.bullGivenDecided,
      baseline: 0.5,
      pRaw: full.bullTest.pValue,
    });
  const mult = multiplierStats(rounds);
  const multRecent = multiplierStats(recent);
  console.log('controls…');
  const ctlFull = controls(rounds, gas);
  const ctlRecent = controls(recent, gas);
  console.log('sequence analysis…');
  const seq = sequenceAnalysis(rounds, gas, hyps);
  const hours = hourAnalysis(rounds, gas, hyps);
  console.log('decision-time pools…');
  const pools = poolAnalysis(rounds, events, gas, hyps);

  const adjusted = benjaminiHochberg(hyps.map((h) => h.pRaw));
  hyps.forEach((h, i) => (h.pAdj = adjusted[i]));
  const adjOf = (id: string) => hyps.find((h) => h.id === id)?.pAdj;
  const survivors = hyps.filter((h) => h.pAdj! < 0.05);

  const tradable: { name: string; stats: BetStats; pAdj: number | undefined }[] = [
    ...seq.contexts
      .filter((c) => c.lag === 2 && c.test)
      .map((c) => ({
        name: `sequence ${c.context} → ${c.predicted}`,
        stats: c.test!,
        pAdj: adjOf(c.hypothesisId),
      })),
    ...hours.map((h) => ({
      name: `hour ${h.hour} → ${h.predicted}`,
      stats: h.test,
      pAdj: adjOf(h.hypothesisId),
    })),
    ...(pools?.perOffset.flatMap((o) => [
      { name: `long-odds side at T−${o.off}s (OOS)`, stats: o.longOddsOos, pAdj: undefined },
      { name: `favourite side at T−${o.off}s (OOS)`, stats: o.favouriteOos, pAdj: undefined },
    ]) ?? []),
  ];
  const edges = tradable.filter((t) => t.stats.clears);
  const headlineBreakEven = ctlFull.random.breakEven;

  const verdict =
    edges.length === 0
      ? `**No edge found.** ${survivors.length} of ${hyps.length} tested hypotheses are statistically significant after ` +
        `Benjamini–Hochberg correction, but none of the ${tradable.length} tradable rules produces an out-of-sample net ` +
        `return whose 95% confidence interval is above zero after the treasury fee and measured gas. A direction-agnostic ` +
        `0.01 BNB bettor needs a **${pct(headlineBreakEven)}** hit rate to break even; the control strategies lose ` +
        `${pct(ctlFull.random.roi)} (random) to ${pct(Math.max(ctlFull.alwaysBull.roi ?? -1, ctlFull.alwaysBear.roi ?? -1))} ` +
        `(best single side) per bet. The research platform remains useful, but the live-execution phases are expected to ` +
        `be unprofitable.`
      : `**${edges.length} candidate rule(s) show an out-of-sample net return with a 95% CI above zero:** ` +
        `${edges.map((e) => e.name).join('; ')}. These are candidates, not discoveries: they still need walk-forward ` +
        `validation, a deflated-Sharpe / reality-check adjustment for the ${tradable.length} rules searched, and ` +
        `decision-time pool reconstruction where relevant before any live use.`;

  const L: string[] = [];
  L.push('# Phase 0 — Viability report', '');
  L.push(
    `Generated ${new Date().toISOString()} by \`npx tsx scripts/viability/phase0.ts\` (read-only; re-run to reproduce).`,
    '',
  );
  L.push('## Verdict', '', verdict, '');
  L.push('## 1. Contract parameters (read live from chain)', '');
  L.push(
    table(
      ['Parameter', 'Value'],
      [
        ['Contract', `\`${CONTRACT}\` (PancakeSwap Prediction V2, BNB/USD, chain 56)`],
        ['treasuryFee', `${params.treasuryFeeBps} bps`],
        ['minBetAmount', `${params.minBetBnb} BNB`],
        ['intervalSeconds', params.intervalSeconds],
        ['bufferSeconds', params.bufferSeconds],
        ['currentEpoch', params.currentEpoch],
        ['paused', String(params.paused)],
        ['oracle', `\`${params.oracle}\``],
        ['Read at', params.readAt],
      ],
    ),
    '',
  );
  L.push('## 2. Data and verification', '');
  L.push(
    `${rounds.length.toLocaleString('en-US')} final rounds (epochs ${rounds[0]!.epoch}–${rounds.at(-1)!.epoch}); the most recent ` +
      `${recent.length.toLocaleString('en-US')} were synced directly from chain, older rounds came from the bsc-predict-updater archive. ` +
      `A deterministic sample was re-read from the contract and every settlement field compared: ` +
      `recent ${verification.recent.checked - verification.recent.mismatches.length}/${verification.recent.checked} identical, ` +
      `archive ${verification.archive.checked - verification.archive.mismatches.length}/${verification.archive.checked} identical` +
      `${verification.recent.mismatches.length + verification.archive.mismatches.length ? ` (mismatched epochs: ${[...verification.recent.mismatches, ...verification.archive.mismatches].join(', ')})` : ''}.`,
    '',
  );
  L.push('## 3. Outcome distribution', '');
  for (const [name, d] of [
    ['Full history', full],
    [`Most recent ${recent.length.toLocaleString('en-US')}`, rec],
  ] as const) {
    L.push(`**${name}** (${d.n.toLocaleString('en-US')} rounds)`, '');
    L.push(
      table(
        ['Outcome', 'Rounds', 'Share', '95% CI'],
        d.rows.map((r) => [r.outcome, r.count.toLocaleString('en-US'), pct(r.share, 3), ci(r.ci, 3)]),
      ),
      '',
    );
    L.push(
      `P(BULL | decided) = ${pct(d.bullGivenDecided, 3)} (95% CI ${ci(d.bullGivenDecidedCi, 3)}; z-test vs 50%: p = ${pv(d.bullTest?.pValue)}).`,
      '',
    );
  }
  L.push('## 4. Payout multipliers and house take', '');
  const mRow = (name: string, x: ReturnType<typeof multiplierStats>['bull']) => [
    name,
    x.n.toLocaleString('en-US'),
    fx(x.mean),
    fx(x.p5),
    fx(x.p25),
    fx(x.p50),
    fx(x.p75),
    fx(x.p95),
  ];
  L.push(
    table(
      ['Multiplier (final pools)', 'Rounds', 'Mean', 'p5', 'p25', 'Median', 'p75', 'p95'],
      [
        mRow('Bull side', mult.bull),
        mRow('Bear side', mult.bear),
        mRow('Winning side (actual)', mult.winner),
        mRow('Winning side, recent', multRecent.winner),
      ],
    ),
    '',
  );
  L.push(
    `House take actually realised: **${pct(mult.poolWeightedTake, 3)} of all BNB staked** (${fx(mult.houseTakeBnb, 1)} of ${fx(mult.totalPoolBnb, 1)} BNB), ` +
      `versus the ${params.treasuryFeeBps / 100}% fee. It exceeds the fee because ties pay nobody (${mult.roundsWithFullTake.toLocaleString('en-US')} rounds lost ` +
      `the whole pot, including ${mult.emptyWinner} where nobody had backed the winning side) — recent: ${pct(multRecent.poolWeightedTake, 3)}. ` +
      `${mult.emptySide.toLocaleString('en-US')} rounds had an empty side; ${mult.roundsWithZeroTake.toLocaleString('en-US')} rounds (cancellations) took nothing.`,
    '',
  );
  L.push('## 5. Gas and break-even accuracy', '');
  L.push(
    `Measured from ${gas.betSamples} recent bet receipts and ${gas.claimSamples} claim receipts: median gas price ${fx(gas.gasPriceGwei, 3)} gwei, ` +
      `bet ${fx(bnb(gas.bet), 7)} BNB, claim transaction ${fx(bnb(gas.claim), 7)} BNB (${fx(bnb(gas.claimPerEpoch), 7)} BNB per epoch when batched). ` +
      `On a 0.01 BNB stake, bet + claim gas is ${pct((bnb(gas.bet) + bnb(gas.claim)) / 0.01, 3)}.`,
    '',
  );
  const beRows = [0.001, 0.005, 0.01, 0.1].map((s) => {
    const w = BigInt(Math.round(s * 1e18));
    return [
      `${s} BNB`,
      pct(breakEven(w, 2 * (1 - params.treasuryFeeBps / 10_000), gas)),
      pct(ctlFull.random.meanWinMultiplier ? breakEven(w, ctlFull.random.meanWinMultiplier, gas) : null),
    ];
  });
  L.push(
    table(
      [
        'Stake',
        `Break-even hit rate at ×${fx(2 * (1 - params.treasuryFeeBps / 10_000), 2)} (balanced pools)`,
        `At the measured mean win multiplier ×${fx(ctlFull.random.meanWinMultiplier)}`,
      ],
      beRows,
    ),
    '',
  );
  L.push(
    `**Headline: a direction-agnostic 0.01 BNB bettor needs a ${pct(headlineBreakEven)} hit rate to break even** (ties count as losses). ` +
      'Every strategy below is judged against its own break-even rate, computed from the multipliers it actually receives.',
    '',
  );
  L.push('## 6. Controls — validates the cost model', '');
  L.push(
    'Bets of 0.01 BNB every round, own stake added to the final pool, all gas charged. A random strategy must come out negative by roughly the house take; if it did not, the backtester would be broken.',
    '',
  );
  L.push(
    table(BET_HEAD, [
      betRow('Always BULL (full)', ctlFull.alwaysBull),
      betRow('Always BEAR (full)', ctlFull.alwaysBear),
      betRow('Random (full)', ctlFull.random),
      betRow('Always BULL (recent)', ctlRecent.alwaysBull),
      betRow('Always BEAR (recent)', ctlRecent.alwaysBear),
      betRow('Random (recent)', ctlRecent.random),
    ]),
    '',
  );
  L.push('## 7. Sequence structure — transition matrices, orders 1–4', '');
  L.push(
    `Train = first ${pct(TRAIN_FRACTION, 0)} of history (${seq.split.toLocaleString('en-US')} rounds), test = the rest. Baseline P(BULL) in train = ${pct(seq.p0Train, 3)}. ` +
      '**Lag 1** is the classic transition matrix (conditions on round n−1), but round n−1 is still running when round n takes bets, so it cannot be traded. ' +
      '**Lag 2** conditions only on rounds ≤ n−2 — what a bettor actually knows — and is traded out-of-sample: bet the side the training data favours.',
    '',
  );
  L.push(
    table(
      [
        'Lag',
        'Context (oldest→newest)',
        'Train n',
        'P(BULL) train',
        'p raw',
        'p BH',
        'P(BULL) test',
        'OOS hit rate',
        'OOS break-even',
        'OOS net ROI',
        'Edge?',
      ],
      seq.contexts.map((c) => {
        const h = hyps.find((x) => x.id === c.hypothesisId);
        return [
          c.lag,
          c.context,
          c.trainN.toLocaleString('en-US'),
          pct(c.trainBull / c.trainN, 2),
          pv(h?.pRaw),
          pv(h?.pAdj),
          pct(c.testBull / c.testN, 2),
          c.test ? `${pct(c.test.hitRate)} (${c.predicted})` : '—',
          c.test ? pct(c.test.breakEven) : '—',
          c.test ? `${pct(c.test.roi)} (${ci(c.test.roiCi)})` : '—',
          c.test ? (c.test.clears ? '**yes**' : 'no') : 'not tradable',
        ];
      }),
    ),
    '',
  );
  L.push('## 8. Time of day (UTC hour of lock)', '');
  L.push(
    table(
      ['Hour', 'Train n', 'P(BULL) train', 'p BH', 'OOS side', 'OOS hit rate', 'OOS net ROI', 'Edge?'],
      hours.map((h) => [
        h.hour,
        h.trainN.toLocaleString('en-US'),
        pct(h.pBull),
        pv(adjOf(h.hypothesisId)),
        h.predicted,
        pct(h.test.hitRate),
        `${pct(h.test.roi)} (${ci(h.test.roiCi)})`,
        h.test.clears ? '**yes**' : 'no',
      ]),
    ),
    '',
  );
  L.push('## 9. Decision-time pools (reconstructed from BetBull/BetBear logs)', '');
  if (!pools) {
    L.push('No bet-event logs cached — run with `--fetch`.', '');
  } else {
    L.push(
      `${pools.sampleRounds.toLocaleString('en-US')} rounds (epochs ${pools.fromEpoch}–${pools.toEpoch}) whose bet events sum exactly, to the wei, to the ` +
        `final Bull and Bear pools (${pools.candidates.toLocaleString('en-US')} rounds had events in the fetched window; the rest were incomplete at the window edges). ` +
        `Pools are rebuilt from events with block timestamp ≤ lockTimestamp − offset. Baseline P(BULL) in the sample: ${pct(pools.p0, 2)}.`,
      '',
    );
    for (const o of pools.perOffset) {
      L.push(`### Decision at T−${o.off}s`, '');
      L.push(
        `- Late flow: on average **${pct(o.lateFlow.mean?.mean)}** of the final pool arrives after T−${o.off}s (median ${pct(o.lateFlow.median)}).`,
        `- Imbalance vs outcome: corr(bull share at T−${o.off}s, BULL) = ${fx(o.correlation?.r, 4)} (n = ${o.correlation?.n ?? 0}, p raw ${pv(o.correlation?.pValue)}, p BH ${pv(adjOf(`pool-corr-T${o.off}`))}). ` +
          `For reference, the *final* share (not available when betting) gives ${fx(o.finalShareCorrelation?.r, 4)}.`,
        `- Slippage (realised − decision-time multiplier; medians, because a few near-empty sides make the means extreme): ` +
          `all sides ${fx(o.slippage.allSides.median, 3)}, long-odds side ${fx(o.slippage.longOddsSide.median, 3)}, ` +
          `favourite side ${fx(o.slippage.favouriteSide.median, 3)} (means ${fx(o.slippage.allSides.mean?.mean, 2)} / ` +
          `${fx(o.slippage.longOddsSide.mean?.mean, 2)} / ${fx(o.slippage.favouriteSide.mean?.mean, 2)}).` +
          ((o.slippage.longOddsSide.median ?? 0) < 0 && (o.slippage.favouriteSide.median ?? 0) > 0
            ? ' Late money flows into the side that looks cheap, pulling the pools back toward balance, so the long odds seen at decision time mostly evaporate by lock.'
            : ''),
        '',
      );
      L.push(
        table(
          ['Bull-share quintile', 'Rounds', 'P(BULL)', '95% CI', 'p BH'],
          o.quintiles.map((q) => [q.quintile, q.n, pct(q.pBull), ci(q.ci), pv(adjOf(q.hypothesisId))]),
        ),
        '',
      );
      L.push(
        table(BET_HEAD, [
          betRow(`Long-odds side at T−${o.off}s (whole sample)`, o.longOdds),
          betRow(`Favourite side at T−${o.off}s (whole sample)`, o.favourite),
          betRow(`Long-odds side at T−${o.off}s (last 30%, OOS)`, o.longOddsOos),
          betRow(`Favourite side at T−${o.off}s (last 30%, OOS)`, o.favouriteOos),
        ]),
        '',
      );
    }
    L.push(
      table(BET_HEAD, [
        betRow('Always BULL (same sample)', pools.controls.alwaysBull),
        betRow('Random (same sample)', pools.controls.random),
      ]),
      '',
    );
  }
  L.push('## 10. Cancelled and unresolved rounds', '');
  const canc = full.rows.find((r) => r.outcome === 'CANCELLED')!;
  const cancR = rec.rows.find((r) => r.outcome === 'CANCELLED')!;
  L.push(
    `${canc.count} of ${full.n.toLocaleString('en-US')} rounds were cancelled (oracle not called in time; stakes refundable) — ${pct(canc.share, 3)} (${ci(canc.ci, 3)}); recent: ${cancR.count} (${pct(cancR.share, 3)}).`,
    '',
  );
  L.push('## 11. Hypothesis log and multiple-testing correction', '');
  L.push(
    `${hyps.length} hypotheses were tested; Benjamini–Hochberg is applied across all of them together. ${survivors.length} survive at 5% FDR. ` +
      'Statistical significance is not profitability: a real but tiny bias still has to clear the break-even hit rate. ' +
      `The complete log (including every failure) is in \`${OUT_DIR}/results.json\`. Smallest raw p-values:`,
    '',
  );
  L.push(
    table(
      ['Hypothesis', 'Family', 'n', 'Estimate', 'Baseline', 'p raw', 'p BH', 'Survives'],
      [...hyps]
        .sort((a, b) => a.pRaw - b.pRaw)
        .slice(0, 20)
        .map((h) => [
          h.label,
          h.family,
          h.n.toLocaleString('en-US'),
          fx(h.estimate, 4),
          fx(h.baseline, 4),
          pv(h.pRaw),
          pv(h.pAdj),
          h.pAdj! < 0.05 ? 'yes' : 'no',
        ]),
    ),
    '',
  );
  L.push('## 12. Limitations', '');
  const lag1 = (ctx: string) => seq.contexts.find((c) => c.lag === 1 && c.context === ctx);
  const afterUp = lag1('U');
  const afterDown = lag1('D');
  L.push(
    [
      afterUp && afterDown
        ? `- Open lead, not testable with this data: round n−1 is still running when round n takes bets, but its live price move is visible. ` +
          `The lag-1 matrix shows mild persistence — P(BULL | previous BULL) ${pct(afterUp.trainBull / afterUp.trainN)} vs ` +
          `P(BULL | previous BEAR) ${pct(afterDown.trainBull / afterDown.trainN)} in train (${pct(afterUp.testBull / afterUp.testN)} vs ` +
          `${pct(afterDown.testBull / afterDown.testN)} in test) — so "bet the live round's current direction" is the most plausible remaining ` +
          `sequence signal. Testing it needs the Chainlink BNB/USD price at T−10s for every round (historical oracle updates), which ` +
          'Phase 0 did not collect. ' +
          (Math.max(afterUp.trainBull / afterUp.trainN, 1 - afterDown.trainBull / afterDown.trainN) <
          (headlineBreakEven ?? 1)
            ? `Even a perfect proxy for the previous outcome would land below the ${pct(headlineBreakEven)} break-even on these numbers.`
            : `On the training numbers a perfect proxy would clear the ${pct(headlineBreakEven)} break-even, so it is worth testing first.`)
        : '',
      `- Decision-time pools come from ${pools ? pools.sampleRounds.toLocaleString('en-US') : 'no'} rounds: the only free RPC serving historical logs (${LOG_RPC}) prunes old blocks. The platform's worker should record every bet event live (\`round_pool_events\`) so this sample grows continuously; a paid archive RPC could backfill it.`,
      "- Payouts model this bettor's own dilution of the final pool, but not other bettors reacting to it.",
      '- T−10s assumes the bet transaction is mined before lock; with ~0.45 s blocks that is realistic but not guaranteed.',
      '- Outcome and sequence statistics use the full history; the archive portion was spot-checked against chain (section 2), not fully re-read.',
      '- Only single-rule strategies were tested here; combinations and parameter searches belong to the Phase 14 discovery engine, which must count every configuration it tries in the multiple-testing budget.',
    ].join('\n'),
    '',
  );

  writeFileSync(REPORT_PATH, L.join('\n'));
  writeFileSync(
    `${OUT_DIR}/results.json`,
    JSON.stringify(
      {
        params,
        verification,
        gas,
        full,
        recent: rec,
        mult,
        multRecent,
        ctlFull,
        ctlRecent,
        seq,
        hours,
        pools,
        hypotheses: hyps,
        verdict,
      },
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  );
  console.log(`\n${verdict}\n\nwrote ${REPORT_PATH} and ${OUT_DIR}/results.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
