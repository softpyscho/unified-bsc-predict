/**
 * Compact, exact transport of research data to the study worker thread. Values live in typed arrays that are
 * transferred, not copied, so handing 500k+ rounds to the worker costs the main thread almost nothing. A wei amount
 * travels as two float64 halves (the bits above 2^52, and the low 52 bits), which is exact up to 2^104 wei.
 */
import type { Direction, ResearchPoolEvent, ResearchRound, RoundOutcome } from '@bsc/core';

const LOW_BITS = 52n;
const LOW_MASK = (1n << LOW_BITS) - 1n;
const OUTCOMES: readonly RoundOutcome[] = ['BULL', 'BEAR', 'TIE', 'CANCELLED'];
/** total, bull, bear, reward, rewardBase */
const ROUND_AMOUNTS = 5;

export interface RoundColumns {
  n: number;
  feeBps: number;
  epoch: Float64Array;
  lockTime: Float64Array;
  outcome: Uint8Array;
  /** ROUND_AMOUNTS wei values per round, two slots each. */
  amounts: Float64Array;
}

export interface EventColumns {
  n: number;
  epoch: Float64Array;
  time: Float64Array;
  /** 0 = BULL, 1 = BEAR */
  side: Uint8Array;
  amounts: Float64Array;
}

function putWei(target: Float64Array, slot: number, wei: bigint): void {
  if (wei < 0n) throw new RangeError('negative wei amount');
  target[2 * slot] = Number(wei >> LOW_BITS);
  target[2 * slot + 1] = Number(wei & LOW_MASK);
}

function getWei(source: Float64Array, slot: number): bigint {
  return (BigInt(source[2 * slot]!) << LOW_BITS) | BigInt(source[2 * slot + 1]!);
}

export function allocRoundColumns(n: number, feeBps: number): RoundColumns {
  return {
    n,
    feeBps,
    epoch: new Float64Array(n),
    lockTime: new Float64Array(n),
    outcome: new Uint8Array(n),
    amounts: new Float64Array(n * ROUND_AMOUNTS * 2),
  };
}

export function setRound(c: RoundColumns, i: number, r: Omit<ResearchRound, 'feeBps'>): void {
  c.epoch[i] = r.epoch;
  c.lockTime[i] = r.lockTime;
  c.outcome[i] = OUTCOMES.indexOf(r.outcome);
  const base = i * ROUND_AMOUNTS;
  putWei(c.amounts, base, r.total);
  putWei(c.amounts, base + 1, r.bull);
  putWei(c.amounts, base + 2, r.bear);
  putWei(c.amounts, base + 3, r.reward);
  putWei(c.amounts, base + 4, r.rewardBase);
}

export function decodeRounds(c: RoundColumns): ResearchRound[] {
  const out = new Array<ResearchRound>(c.n);
  for (let i = 0; i < c.n; i++) {
    const base = i * ROUND_AMOUNTS;
    out[i] = {
      epoch: c.epoch[i]!,
      lockTime: c.lockTime[i]!,
      outcome: OUTCOMES[c.outcome[i]!]!,
      total: getWei(c.amounts, base),
      bull: getWei(c.amounts, base + 1),
      bear: getWei(c.amounts, base + 2),
      reward: getWei(c.amounts, base + 3),
      rewardBase: getWei(c.amounts, base + 4),
      feeBps: c.feeBps,
    };
  }
  return out;
}

export function allocEventColumns(n: number): EventColumns {
  return {
    n,
    epoch: new Float64Array(n),
    time: new Float64Array(n),
    side: new Uint8Array(n),
    amounts: new Float64Array(n * 2),
  };
}

export function setEvent(
  c: EventColumns,
  i: number,
  e: { epoch: number; time: number; side: Direction; amount: bigint },
): void {
  c.epoch[i] = e.epoch;
  c.time[i] = e.time;
  c.side[i] = e.side === 'BULL' ? 0 : 1;
  putWei(c.amounts, i, e.amount);
}

export function decodeEvents(c: EventColumns): Map<number, ResearchPoolEvent[]> {
  const out = new Map<number, ResearchPoolEvent[]>();
  for (let i = 0; i < c.n; i++) {
    const epoch = c.epoch[i]!;
    let list = out.get(epoch);
    if (!list) out.set(epoch, (list = []));
    list.push({ time: c.time[i]!, side: c.side[i] === 0 ? 'BULL' : 'BEAR', amount: getWei(c.amounts, i) });
  }
  return out;
}

export function transferList(rounds: RoundColumns, events: EventColumns | null): ArrayBuffer[] {
  const views = [rounds.epoch, rounds.lockTime, rounds.outcome, rounds.amounts];
  if (events) views.push(events.epoch, events.time, events.side, events.amounts);
  return views.map((v) => v.buffer as ArrayBuffer);
}
