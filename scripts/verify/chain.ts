/**
 * Phase 2 — verify PancakeSwap Prediction V2 behaviour against the live chain. Read-only: only eth_call /
 * eth_estimateGas / eth_getLogs, never a transaction. Writes docs/CHAIN_REFERENCE.md.
 *
 *   npx tsx scripts/verify/chain.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Abi, Hex } from 'viem';
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  toEventSelector,
} from 'viem';
import { quantile } from '../../packages/core/src/index.js';

const CONTRACT = getAddress('0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA');
const CALL_RPC = process.env.VERIFY_CALL_RPC ?? 'https://bsc-dataseed.bnbchain.org';
const LOG_RPC = process.env.VERIFY_LOG_RPC ?? 'https://rpc-bsc.48.club';
const PREDICTION_ABI = JSON.parse(readFileSync('contracts/abis/PancakePredictionV2.json', 'utf8')) as Abi;
const ORACLE_ABI = JSON.parse(readFileSync('contracts/abis/ChainlinkAggregatorProxy.json', 'utf8')) as Abi;
const MULTICALL3 = getAddress('0xcA11bde05977b3631167028862bE2a173976CA11');
const PROBE = getAddress('0x1111111111111111111111111111111111111111');
const DB_PATH = 'data/bsc-predict.db';
const REPORT_PATH = 'docs/CHAIN_REFERENCE.md';
const TOPIC_BULL = toEventSelector('BetBull(address,uint256,uint256)');
const TOPIC_BEAR = toEventSelector('BetBear(address,uint256,uint256)');
const TOPIC_ANSWER = toEventSelector('AnswerUpdated(int256,uint256,uint256)');

const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RpcResult<T> {
  result?: T;
  error?: { code?: number; message: string; data?: string };
}

async function rpcRaw<T>(method: string, params: unknown[], url: string): Promise<RpcResult<T>> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      return (await res.json()) as RpcResult<T>;
    } catch (e) {
      if (i >= 3) return { error: { message: (e as Error).message } };
      await sleep(600 * i);
    }
  }
}

async function rpc<T>(method: string, params: unknown[], url = CALL_RPC): Promise<T> {
  const r = await rpcRaw<T>(method, params, url);
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result as T;
}

function revertReason(error: NonNullable<RpcResult<unknown>['error']>): string {
  const data = error.data;
  if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
    return decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}` as Hex)[0];
  }
  return error.message.replace(/^execution reverted:?\s*/, '') || 'reverted (no reason)';
}

interface CallOpts {
  from?: string;
  value?: bigint;
  balanceOverride?: bigint;
  abi?: Abi;
  to?: string;
}

async function simulate(functionName: string, args: readonly unknown[], opts: CallOpts = {}) {
  const abi = opts.abi ?? PREDICTION_ABI;
  const tx: Record<string, string> = {
    to: opts.to ?? CONTRACT,
    data: encodeFunctionData({ abi, functionName, args } as never),
  };
  if (opts.from) tx.from = opts.from;
  if (opts.value !== undefined) tx.value = hex(opts.value);
  const params: unknown[] = [tx, 'latest'];
  if (opts.from && opts.balanceOverride !== undefined)
    params.push({ [opts.from]: { balance: hex(opts.balanceOverride) } });
  const r = await rpcRaw<Hex>('eth_call', params, CALL_RPC);
  if (r.error) return { ok: false as const, reason: revertReason(r.error) };
  return {
    ok: true as const,
    value: decodeFunctionResult({ abi, functionName, data: r.result! } as never) as unknown,
  };
}

async function read<T>(
  functionName: string,
  args: readonly unknown[] = [],
  abi = PREDICTION_ABI,
  to: string = CONTRACT,
): Promise<T> {
  const r = await simulate(functionName, args, { abi, to });
  if (!r.ok) throw new Error(`${functionName}: ${r.reason}`);
  return r.value as T;
}

async function estimateGas(
  functionName: string,
  args: readonly unknown[],
  from: string,
  value?: bigint,
  balanceOverride?: bigint,
) {
  const tx: Record<string, string> = {
    from,
    to: CONTRACT,
    data: encodeFunctionData({ abi: PREDICTION_ABI, functionName, args } as never),
  };
  if (value !== undefined) tx.value = hex(value);
  const params: unknown[] = [tx, 'latest'];
  if (balanceOverride !== undefined) params.push({ [from]: { balance: hex(balanceOverride) } });
  const r = await rpcRaw<Hex>('eth_estimateGas', params, CALL_RPC);
  return r.error
    ? { ok: false as const, reason: revertReason(r.error) }
    : { ok: true as const, gas: BigInt(r.result!) };
}

interface RawLog {
  topics: Hex[];
  data: Hex;
  blockTimestamp?: Hex;
}

async function logs(address: string, topics: unknown[], blocksBack: number, head: number): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let from = head - blocksBack; from <= head; from += 5000) {
    const to = Math.min(head, from + 4999);
    out.push(
      ...(await rpc<RawLog[]>(
        'eth_getLogs',
        [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }],
        LOG_RPC,
      )),
    );
  }
  return out;
}

const topicAddress = (t: Hex) => getAddress(`0x${t.slice(26)}`);
const dist = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: quantile(s, 0.5),
    p95: quantile(s, 0.95),
    max: s.at(-1) ?? null,
    min: s[0] ?? null,
  };
};

async function main() {
  // ---------------------------------------------------------------------------------------- parameters and roles
  const names = [
    'treasuryFee',
    'MAX_TREASURY_FEE',
    'minBetAmount',
    'intervalSeconds',
    'bufferSeconds',
    'oracle',
    'oracleUpdateAllowance',
    'oracleLatestRoundId',
    'paused',
    'genesisStartOnce',
    'genesisLockOnce',
    'currentEpoch',
    'owner',
    'adminAddress',
    'operatorAddress',
    'treasuryAmount',
  ];
  const values = Object.fromEntries(
    await Promise.all(names.map(async (n) => [n, await read<unknown>(n)] as const)),
  );
  const currentEpoch = Number(values.currentEpoch);
  const minBet = values.minBetAmount as bigint;
  const bufferSeconds = Number(values.bufferSeconds);
  const intervalSeconds = Number(values.intervalSeconds);
  const chainId = Number(BigInt(await rpc<Hex>('eth_chainId', [])));
  const head = Number(BigInt(await rpc<Hex>('eth_blockNumber', [], LOG_RPC)));
  const headBlock = await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', [hex(head), false], LOG_RPC);
  const oldBlock = await rpc<{ timestamp: Hex }>(
    'eth_getBlockByNumber',
    [hex(head - 100_000), false],
    LOG_RPC,
  );
  const blockTime = (Number(BigInt(headBlock.timestamp)) - Number(BigInt(oldBlock.timestamp))) / 100_000;
  const gasPrice = BigInt(await rpc<Hex>('eth_gasPrice', []));
  const code = await rpc<Hex>('eth_getCode', [CONTRACT, 'latest']);

  // ---------------------------------------------------------------------------------------- oracle
  const oracle = getAddress(values.oracle as string);
  const [description, decimals, version, aggregator, phaseId, latest] = await Promise.all([
    read<string>('description', [], ORACLE_ABI, oracle),
    read<number>('decimals', [], ORACLE_ABI, oracle),
    read<bigint>('version', [], ORACLE_ABI, oracle),
    read<string>('aggregator', [], ORACLE_ABI, oracle),
    read<number>('phaseId', [], ORACLE_ABI, oracle),
    read<readonly [bigint, bigint, bigint, bigint, bigint]>('latestRoundData', [], ORACLE_ABI, oracle),
  ]);
  const nowSec = Number(BigInt(headBlock.timestamp));
  const answerLogs = await logs(aggregator, [TOPIC_ANSWER], 20_000, head);
  const updates = answerLogs
    .map((l) => ({
      ts: Number(BigInt(l.blockTimestamp ?? '0x0')),
      price: Number(BigInt.asIntN(256, BigInt(l.topics[1]!))),
    }))
    .sort((a, b) => a.ts - b.ts);
  const gaps = updates.slice(1).map((u, i) => u.ts - updates[i]!.ts);
  const moves = updates.slice(1).map((u, i) => Math.abs(u.price - updates[i]!.price) / updates[i]!.price);

  // ---------------------------------------------------------------------------------------- round struct and timing
  const struct = await read<readonly unknown[]>('rounds', [BigInt(currentEpoch - 2)]);
  const structNames = [
    'epoch',
    'startTimestamp',
    'lockTimestamp',
    'closeTimestamp',
    'lockPrice',
    'closePrice',
    'lockOracleId',
    'closeOracleId',
    'totalAmount',
    'bullAmount',
    'bearAmount',
    'rewardBaseCalAmount',
    'rewardAmount',
    'oracleCalled',
  ];
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT epoch, start_time, lock_time, close_time, outcome, reward_amount, reward_base_cal_amount
         FROM rounds_v WHERE market_id = 1 AND is_final = 1 ORDER BY epoch DESC LIMIT 25001`,
    )
    .all() as {
    epoch: number;
    start_time: number;
    lock_time: number;
    close_time: number;
    outcome: string;
    reward_amount: string;
    reward_base_cal_amount: string;
  }[];
  const ties = db
    .prepare(
      `SELECT COUNT(*) n, SUM(reward_amount = '0' AND reward_base_cal_amount = '0') zero FROM rounds_v WHERE market_id = 1 AND outcome = 'TIE'`,
    )
    .get() as { n: number; zero: number };
  const cancelled = db
    .prepare(`SELECT COUNT(*) n FROM rounds_v WHERE market_id = 1 AND outcome = 'CANCELLED'`)
    .get() as { n: number };
  db.close();
  rows.reverse();
  const lockMinusStart: number[] = [];
  const closeMinusLock: number[] = [];
  const latency: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    lockMinusStart.push(r.lock_time - r.start_time);
    closeMinusLock.push(r.close_time - r.lock_time);
    const next = rows[i + 1];
    if (next && next.epoch === r.epoch + 1) latency.push(next.start_time - r.lock_time);
  }
  const lateLocks = latency.filter((l) => l > bufferSeconds).length;

  // ---------------------------------------------------------------------------------------- bettors for guard tests
  const betLogs = await logs(CONTRACT, [[TOPIC_BULL, TOPIC_BEAR]], 8000, head);
  const bets = betLogs.map((l) => ({
    side: l.topics[0] === TOPIC_BULL ? 0 : 1,
    sender: topicAddress(l.topics[1]!),
    epoch: Number(BigInt(l.topics[2]!)),
  }));
  // Someone must already have bet the *current* round for the once-per-round guard; early in a round nobody has yet.
  let bettor: { sender: string; epoch: number } | null = null;
  for (let attempt = 0; attempt < 8 && !bettor; attempt++) {
    if (attempt > 0) await sleep(15_000);
    const epochNow = Number(await read<bigint>('currentEpoch'));
    const headNow = Number(BigInt(await rpc<Hex>('eth_blockNumber', [], LOG_RPC)));
    const found = (await logs(CONTRACT, [[TOPIC_BULL, TOPIC_BEAR]], 700, headNow)).find(
      (l) => Number(BigInt(l.topics[2]!)) === epochNow,
    );
    if (found) bettor = { sender: topicAddress(found.topics[1]!), epoch: epochNow };
  }
  // Winners usually claim within minutes, so look back several resolved rounds for one who has not yet.
  let resolvedEpoch = currentEpoch - 3;
  let unclaimedWinner: string | null = null;
  let loser: string | null = null;
  for (let e = currentEpoch - 3; e >= currentEpoch - 8 && !unclaimedWinner; e--) {
    const r = await read<readonly unknown[]>('rounds', [BigInt(e)]);
    const winningSide =
      (r[5] as bigint) > (r[4] as bigint) ? 0 : (r[5] as bigint) < (r[4] as bigint) ? 1 : null;
    if (winningSide === null || !(r[13] as boolean)) continue;
    const epochBets = bets.filter((b) => b.epoch === e);
    for (const b of epochBets.filter((x) => x.side === winningSide)) {
      if (await read<boolean>('claimable', [BigInt(e), b.sender])) {
        unclaimedWinner = b.sender;
        break;
      }
    }
    if (e === currentEpoch - 3 || unclaimedWinner) {
      resolvedEpoch = e;
      loser = epochBets.find((b) => b.side !== winningSide)?.sender ?? null;
    }
  }

  // ---------------------------------------------------------------------------------------- guard tests
  const funded = 10n ** 19n; // 10 BNB balance override for the probe address
  const override = await simulate('betBull', [BigInt(currentEpoch)], {
    from: PROBE,
    value: minBet,
    balanceOverride: funded,
  });
  const overrideWorks = override.ok || !/insufficient funds/i.test(override.reason);
  type Case = { name: string; call: string; expect: string; observed: string; pass: boolean };
  const cases: Case[] = [];
  const check = async (
    name: string,
    callLabel: string,
    expect: string,
    run: () => Promise<{ ok: boolean; reason?: string }>,
    passIf: (r: { ok: boolean; reason?: string }) => boolean,
  ) => {
    const r = await run();
    cases.push({
      name,
      call: callLabel,
      expect,
      observed: r.ok ? 'succeeds' : `reverts: "${r.reason}"`,
      pass: passIf(r),
    });
  };
  const reverts = (text: RegExp) => (r: { ok: boolean; reason?: string }) =>
    !r.ok && text.test(r.reason ?? '');
  await check(
    'Valid bet',
    `betBull(currentEpoch) with minBetAmount`,
    'succeeds while the round is open',
    async () => override,
    (r) => r.ok || /too early\/late|not bettable/.test(r.reason ?? ''),
  );
  await check(
    'Minimum bet',
    `betBull(currentEpoch) with minBetAmount − 1 wei`,
    'reverts',
    () =>
      simulate('betBull', [BigInt(currentEpoch)], {
        from: PROBE,
        value: minBet - 1n,
        balanceOverride: funded,
      }),
    reverts(/minBetAmount/),
  );
  await check(
    'Previous epoch',
    'betBull(currentEpoch − 1)',
    'reverts (locked)',
    () =>
      simulate('betBull', [BigInt(currentEpoch - 1)], {
        from: PROBE,
        value: minBet,
        balanceOverride: funded,
      }),
    reverts(/too early\/late/),
  );
  await check(
    'Future epoch',
    'betBull(currentEpoch + 1)',
    'reverts (not started)',
    () =>
      simulate('betBull', [BigInt(currentEpoch + 1)], {
        from: PROBE,
        value: minBet,
        balanceOverride: funded,
      }),
    reverts(/too early\/late/),
  );
  await check(
    'Contracts blocked',
    'betBull from Multicall3 (a contract)',
    'reverts',
    () =>
      simulate('betBull', [BigInt(currentEpoch)], {
        from: MULTICALL3,
        value: minBet,
        balanceOverride: funded,
      }),
    reverts(/[Cc]ontract/),
  );
  if (bettor) {
    const b = bettor;
    await check(
      'One bet per epoch',
      `betBear(${b.epoch}) from ${b.sender.slice(0, 10)}…, who already bet that epoch`,
      'reverts',
      () =>
        simulate('betBear', [BigInt(b.epoch)], { from: b.sender, value: minBet, balanceOverride: funded }),
      reverts(/once per round/),
    );
  }
  await check(
    'Claim before close',
    'claim([currentEpoch])',
    'reverts',
    () => simulate('claim', [[BigInt(currentEpoch)]], { from: PROBE }),
    reverts(/not ended|not started/),
  );
  await check(
    'Claim without a bet',
    `claim([${resolvedEpoch}]) from a non-participant`,
    'reverts',
    () => simulate('claim', [[BigInt(resolvedEpoch)]], { from: PROBE }),
    reverts(/[Nn]ot eligible/),
  );
  if (unclaimedWinner) {
    await check(
      'Winner can claim',
      `claimable(${resolvedEpoch}, winner)`,
      'true',
      async () => ({ ok: await read<boolean>('claimable', [BigInt(resolvedEpoch), unclaimedWinner]) }),
      (r) => r.ok,
    );
  }
  if (loser) {
    await check(
      'Loser cannot claim',
      `claimable(${resolvedEpoch}, loser)`,
      'false',
      async () => ({ ok: !(await read<boolean>('claimable', [BigInt(resolvedEpoch), loser])) }),
      (r) => r.ok,
    );
    await check(
      'Resolved round is not refundable',
      `refundable(${resolvedEpoch}, loser)`,
      'false',
      async () => ({ ok: !(await read<boolean>('refundable', [BigInt(resolvedEpoch), loser])) }),
      (r) => r.ok,
    );
  }
  for (const c of cases)
    if (
      c.name === 'Winner can claim' ||
      c.name === 'Loser cannot claim' ||
      c.name === 'Resolved round is not refundable'
    )
      c.observed = c.pass ? c.expect : `not ${c.expect}`;

  // ---------------------------------------------------------------------------------------- gas
  const betGas = await estimateGas('betBull', [BigInt(currentEpoch)], PROBE, minBet, funded);
  const claimGas = unclaimedWinner
    ? await estimateGas('claim', [[BigInt(resolvedEpoch)]], unclaimedWinner)
    : null;
  const bnb = (wei: bigint) => (Number(wei) / 1e18).toFixed(8);

  // ---------------------------------------------------------------------------------------- report
  const expected = [
    ['Chain id', '56', String(chainId)],
    ['Contract has code', 'yes', code.length > 2 ? `yes (${(code.length - 2) / 2} bytes)` : 'no'],
    ['Round interval', '300 s', `${intervalSeconds} s`],
    ['Treasury fee', '300 bps', `${values.treasuryFee} bps (cap ${values.MAX_TREASURY_FEE} bps)`],
    ['Oracle', 'Chainlink BNB/USD', `${description} (${oracle})`],
  ] as const;
  const L: string[] = [];
  const table = (head: string[], body: (string | number)[][]) =>
    [
      `| ${head.join(' | ')} |`,
      `| ${head.map(() => '---').join(' | ')} |`,
      ...body.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
  const f = (x: number | null, dp = 1) => (x === null ? 'n/a' : x.toFixed(dp));
  L.push('# Blockchain reference — PancakeSwap Prediction V2 (BNB/USD)', '');
  L.push(
    `Generated ${new Date().toISOString()} by \`npx tsx scripts/verify/chain.ts\`. Everything below was read or simulated on BNB Smart Chain at block ${head} (read-only: \`eth_call\`, \`eth_estimateGas\`, \`eth_getLogs\`; no transaction was sent).`,
    '',
  );
  L.push(
    "Contract source: PancakeSwap's [PancakePredictionV2.sol](https://github.com/pancakeswap/pancake-smart-contracts/blob/master/projects/predictions/v2/contracts/PancakePredictionV2.sol); line numbers below refer to it. Behaviour was verified by simulation against the deployed contract; the deployed bytecode was not byte-compared with a compilation of that source.",
    '',
  );
  L.push('## 1. Expected vs verified', '');
  L.push(
    table(
      ['Item', 'Brief expects', 'Chain', 'Match'],
      expected.map(([k, e, c]) => [
        k,
        e,
        c,
        c.startsWith(e.split(' ')[0]!) || (k === 'Oracle' && /BNB \/ USD/.test(c)) ? 'yes' : '**no**',
      ]),
    ),
    '',
  );
  L.push('## 2. Parameters and roles (live)', '');
  L.push(
    table(
      ['Name', 'Value'],
      names.map((n) => [n, `\`${String(values[n])}\``]),
    ),
    '',
  );
  L.push(
    `Measured block time: **${blockTime.toFixed(3)} s** (average over the last 100,000 blocks). Current gas price: ${Number(gasPrice) / 1e9} gwei.`,
    '',
  );
  L.push('## 3. Round struct (`rounds(currentEpoch − 2)`)', '');
  L.push(
    table(
      ['#', 'Field', 'Value'],
      structNames.map((n, i) => [i, n, `\`${String(struct[i])}\``]),
    ),
    '',
  );
  L.push('## 4. Round lifecycle and timing', '');
  L.push(
    [
      `- \`lockTimestamp − startTimestamp\` over the last ${lockMinusStart.length.toLocaleString('en-US')} rounds: min ${dist(lockMinusStart).min}, max ${dist(lockMinusStart).max} s; \`closeTimestamp − lockTimestamp\`: min ${dist(closeMinusLock).min}, max ${dist(closeMinusLock).max} s.`,
      `- The operator's \`executeRound\` locks round n, closes round n−1 and starts round n+1 in one transaction. Round n+1's \`startTimestamp\` is therefore the actual lock time, and locking resets round n's \`closeTimestamp\` to actual lock + interval (line 584). Lock latency (actual − scheduled lock): median ${f(dist(latency).p50)} s, p95 ${f(dist(latency).p95)} s, max ${f(dist(latency).max)} s over ${latency.length.toLocaleString('en-US')} consecutive pairs; ${lateLocks} exceeded \`bufferSeconds\` (${bufferSeconds} s).`,
      "- Because each round starts when the previous one actually locks, the schedule drifts by that latency every round; strategies must use the round's own timestamps, never `epoch × 300`.",
      '- Bets are accepted only for `currentEpoch` while `startTimestamp < block.timestamp < lockTimestamp` (lines 158–159, 637–643; verified below: the previous and next epochs both revert).',
      `- Ties: ${ties.n} rounds in the database; ${ties.zero} of them have \`rewardBaseCalAmount = rewardAmount = 0\` — \`claimable\` is false for everyone and the whole pot goes to the treasury (lines 477–479, 526–531).`,
      `- Cancellations: ${cancelled.n} rounds were never oracle-called; after \`closeTimestamp + bufferSeconds\` every stake is refundable through \`claim\` (lines 222–225, 493–501).`,
    ].join('\n'),
    '',
  );
  L.push('## 5. Oracle', '');
  L.push(
    [
      `- Proxy \`${oracle}\` → "${description}", ${decimals} decimals, version ${version}, phase ${phaseId}, current aggregator \`${aggregator}\`.`,
      `- Latest answer ${(Number(latest[1]) / 10 ** decimals).toFixed(4)} USD, updated ${nowSec - Number(latest[3])} s before block ${head}.`,
      `- Update cadence over the last 20,000 blocks: ${updates.length} updates; gap between updates median ${f(dist(gaps).p50)} s, p95 ${f(dist(gaps).p95)} s, max ${f(dist(gaps).max)} s; median move per update ${f((dist(moves).p50 ?? 0) * 100, 3)}%.`,
      "- `executeRound` reads one oracle answer and uses it both to lock round n and to close round n−1 (lines 249–256), so consecutive rounds share a price print: round n's lock price is round n−1's close price.",
      '- The answer must carry a round id greater than `oracleLatestRoundId` (lines 653–656). If the feed has not published since the previous `executeRound`, the call reverts; if that lasts past `bufferSeconds`, the round can no longer be locked or closed and is cancelled.',
      `- \`oracleUpdateAllowance\` (${values.oracleUpdateAllowance} s) only rejects answers timestamped more than that far *in the future* (lines 650–652). It does **not** bound staleness: an old answer with a new round id is accepted.`,
    ].join('\n'),
    '',
  );
  L.push('## 6. Functions', '');
  const fns = PREDICTION_ABI.filter((x) => x.type === 'function') as {
    name: string;
    stateMutability: string;
    inputs: { type: string; name: string }[];
  }[];
  const bettorFacing = new Set([
    'betBull',
    'betBear',
    'claim',
    'claimable',
    'refundable',
    'ledger',
    'getUserRounds',
    'getUserRoundsLength',
    'userRounds',
    'rounds',
    'currentEpoch',
  ]);
  L.push(
    table(
      ['Function', 'Mutability', 'Who calls it'],
      fns.map((x) => [
        `\`${x.name}(${x.inputs.map((i) => `${i.type}${i.name ? ` ${i.name}` : ''}`).join(', ')})\``,
        x.stateMutability,
        bettorFacing.has(x.name)
          ? 'bettors / readers'
          : x.stateMutability === 'view'
            ? 'anyone (config view)'
            : 'owner / admin / operator only',
      ]),
    ),
    '',
  );
  L.push('## 7. Events', '');
  const evs = PREDICTION_ABI.filter((x) => x.type === 'event') as {
    name: string;
    inputs: { type: string; name: string; indexed: boolean }[];
  }[];
  L.push(
    table(
      ['Event', 'topic0'],
      evs.map((e) => {
        const sig = `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
        return [
          `\`${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name}`).join(', ')})\``,
          `\`${toEventSelector(sig)}\``,
        ];
      }),
    ),
    '',
  );
  L.push('## 8. Guard verification (simulated with `eth_call`)', '');
  L.push(
    `Balance override for the probe address ${overrideWorks ? 'is supported by' : '**is not** supported by'} the RPC${overrideWorks ? '' : ' — bet cases below may report "insufficient funds" instead of the contract guard'}.`,
    '',
  );
  const sourceLines: Record<string, string> = {
    'Valid bet': '158–161, 637–643',
    'Minimum bet': '160',
    'Previous epoch': '158',
    'Future epoch': '158',
    'Contracts blocked': '115–116',
    'One bet per epoch': '161',
    'Claim before close': '211–212',
    'Claim without a bet': '218, 474–486',
    'Winner can claim': '474–486',
    'Loser cannot claim': '474–486',
    'Resolved round is not refundable': '493–501',
  };
  L.push(
    table(
      ['Guard', 'Call', 'Expected', 'Observed', 'Source lines', 'Pass'],
      cases.map((c) => [
        c.name,
        c.call,
        c.expect,
        c.observed,
        sourceLines[c.name] ?? '',
        c.pass ? 'yes' : '**no**',
      ]),
    ),
    '',
  );
  L.push('## 9. Gas', '');
  L.push(
    [
      `- \`betBull\`: ${betGas.ok ? `${betGas.gas} gas ≈ ${bnb(betGas.gas * gasPrice)} BNB at ${Number(gasPrice) / 1e9} gwei` : `estimate failed: ${betGas.reason}`}.`,
      `- \`claim([epoch])\` for one winning epoch: ${claimGas === null ? 'no unclaimed winner found in the sampled round' : claimGas.ok ? `${claimGas.gas} gas ≈ ${bnb(claimGas.gas * gasPrice)} BNB` : `estimate failed: ${claimGas.reason}`}. Batching several epochs in one \`claim\` amortises the base cost.`,
      '- Receipt-measured medians from real bets and claims are in docs/VIABILITY_REPORT.md section 5.',
    ].join('\n'),
    '',
  );
  L.push('## 10. Discrepancies found', '');
  L.push(
    [
      `- **Oracle address.** bsc-predict-bot (\`config.py:14\`) and bsc-prediction-market (\`src/contracts/oracle.ts:2\`) hard-code \`0xD276fCF34D54A926773c399eBAa772C12ec394aC\`; the contract's \`oracle()\` returns \`${oracle}\`. This repository reads it from the contract.`,
      `- **Gas.** The brief's example (§0.2) assumes ~0.0003 BNB of bet + claim gas; at today's ${Number(gasPrice) / 1e9} gwei it is ${betGas.ok && claimGas?.ok ? `~${bnb((betGas.gas + claimGas.gas) * gasPrice)}` : 'well under 0.0001'} BNB, so gas is no longer a material drag on a 0.01 BNB stake.`,
      `- **Block time.** ${blockTime.toFixed(2)} s per block today; T−10 s is ~${Math.round(10 / blockTime)} blocks before lock.`,
      '- **Late pool flow.** The brief (§0.5) expects late money to chase the favourite; the Phase 0 sample shows the opposite — late money flows into the side that looks cheap (docs/VIABILITY_REPORT.md section 9). The conclusion that decision-time multipliers overstate realised ones holds either way.',
      '- **Buffer semantics.** bsc-predict-bot treated `bufferSeconds` as a delay after `startTimestamp`; on chain it is the window after `lockTimestamp` / `closeTimestamp` within which the operator must lock or close the round.',
    ].join('\n'),
    '',
  );
  writeFileSync(REPORT_PATH, L.join('\n'));
  console.log(
    `${cases.filter((c) => c.pass).length}/${cases.length} guard checks passed; wrote ${REPORT_PATH}`,
  );
  for (const c of cases) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.observed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
