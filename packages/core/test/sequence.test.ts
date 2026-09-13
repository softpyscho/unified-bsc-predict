import { describe, expect, it } from 'vitest';
import type { Direction } from '../src/index.js';
import {
  alternationContinuationEstimate,
  alternationLength,
  buildNGramTable,
  contextKey,
  currentStreak,
  estimateFor,
  formatSequence,
  lastTransition,
  opposite,
  persistenceEstimate,
  streakContinuationEstimate,
  toSequence,
  transitionMatrix1,
  transitionMatrix2,
} from '../src/sequence.js';

const U: Direction = 'BULL';
const D: Direction = 'BEAR';
const seq = (s: string): Direction[] => s.split('').map((c) => (c === 'U' ? U : D));

describe('toSequence', () => {
  it('drops ties and cancellations, keeping the count of each', () => {
    const rows = [
      { outcome: 'BULL' },
      { outcome: 'TIE' },
      { outcome: 'BEAR' },
      { outcome: 'CANCELLED' },
      { outcome: null },
      { outcome: 'BULL' },
    ] as const;
    const history = rows.map((r, i) => ({ epoch: i, outcome: r.outcome }) as never);
    const s = toSequence(history);
    expect(s.directions).toEqual([U, D, U]);
    expect(s.skipped).toBe(2); // TIE + CANCELLED; null (still pending) is not "skipped"
    expect(s.rounds.map((r) => r.epoch)).toEqual([0, 2, 5]);
  });
});

describe('opposite', () => {
  it('flips', () => {
    expect(opposite(U)).toBe(D);
    expect(opposite(D)).toBe(U);
  });
});

describe('currentStreak', () => {
  it('counts the trailing run', () => {
    expect(currentStreak([])).toEqual({ direction: null, length: 0 });
    expect(currentStreak(seq('U'))).toEqual({ direction: U, length: 1 });
    expect(currentStreak(seq('DUUU'))).toEqual({ direction: U, length: 3 });
    expect(currentStreak(seq('UUUD'))).toEqual({ direction: D, length: 1 });
  });
});

describe('lastTransition', () => {
  it('finds the most recent direction change and the run before it', () => {
    expect(lastTransition(seq('UUUU'))).toBeNull();
    expect(lastTransition(seq('U'))).toBeNull();
    const t = lastTransition(seq('UUDDD'))!;
    expect(t).toEqual({ index: 2, from: U, to: D, previousRunLength: 2 });
    // Only the most recent transition, even with an earlier one further back.
    const t2 = lastTransition(seq('DUUDDU'))!;
    expect(t2).toEqual({ index: 5, from: D, to: U, previousRunLength: 2 });
  });
});

describe('alternationLength', () => {
  it('measures the trailing strictly-alternating run', () => {
    expect(alternationLength([])).toBe(0);
    expect(alternationLength(seq('U'))).toBe(1);
    expect(alternationLength(seq('UDUD'))).toBe(4);
    expect(alternationLength(seq('UUDUD'))).toBe(4); // trailing D,U,D,U alternates; the leading extra U does not
    expect(alternationLength(seq('UDUDD'))).toBe(1); // breaks right at the end
  });
});

describe('n-grams', () => {
  it('builds exact counts and reads them back', () => {
    // U U U D U U  (order 2): contexts UU→U, UU→D, UD→U, DU→U
    const s = seq('UUUDUU');
    const table = buildNGramTable(s, 2);
    expect(table.get(contextKey([U, U]))).toEqual({ up: 1, down: 1 });
    expect(table.get(contextKey([U, D]))).toEqual({ up: 1, down: 0 });
    expect(table.get(contextKey([D, U]))).toEqual({ up: 1, down: 0 });
    expect(estimateFor(table, [U, U])).toEqual({ pUp: 0.5, pDown: 0.5, sampleSize: 2 });
    expect(estimateFor(table, [D, D])).toEqual({ pUp: null, pDown: null, sampleSize: 0 });
  });

  it('order 0 gives the unconditional base rate', () => {
    const table = buildNGramTable(seq('UUUD'), 0);
    expect(estimateFor(table, [])).toEqual({ pUp: 0.75, pDown: 0.25, sampleSize: 4 });
  });

  it('persistenceEstimate reads the table at the current tail context', () => {
    const s = seq('UUUDUU'); // as above
    const p = persistenceEstimate(s, 2)!;
    expect(p.direction).toBe(U);
    expect(p.pSame).toBe(0.5);
    expect(p.pOpposite).toBe(0.5);
    expect(p.sampleSize).toBe(2);
    // Tail streak (2) shorter than requested order (3): not enough context to condition on.
    expect(persistenceEstimate(s, 3)).toBeNull();
  });

  it('streakContinuationEstimate requires an exact current streak length match', () => {
    const s = seq('UUUDUU'); // tail streak = U,2
    expect(streakContinuationEstimate(s, 2)).toEqual({
      direction: U,
      pContinue: 0.5,
      pBreak: 0.5,
      sampleSize: 2,
    });
    expect(streakContinuationEstimate(s, 3)).toBeNull(); // tail is only 2 long
  });

  it('transitionMatrix1 matches hand computation', () => {
    // U D U U D  → contexts: U→D, D→U, U→U, U→D
    const m = transitionMatrix1(seq('UDUUD'));
    expect(m.BULL).toEqual({ toUp: 1 / 3, toDown: 2 / 3, sampleSize: 3 });
    expect(m.BEAR).toEqual({ toUp: 1, toDown: 0, sampleSize: 1 });
  });

  it('transitionMatrix2 has all four second-order contexts', () => {
    const m = transitionMatrix2(seq('UUDUUDUU'));
    expect(Object.keys(m).sort()).toEqual(['BEAR→BEAR', 'BEAR→BULL', 'BULL→BEAR', 'BULL→BULL']);
    expect(m['BULL→BULL']!.sampleSize).toBeGreaterThan(0);
  });
});

describe('alternationContinuationEstimate', () => {
  it('requires the current run to meet the minimum length', () => {
    expect(alternationContinuationEstimate(seq('UD'), 3)).toBeNull();
  });

  it('cross-checks against a straightforward reference implementation over a mixed sequence', () => {
    // A deterministic pseudo-random 0/1 stream (not alternating by construction), which exercises runs of
    // many different lengths, breaks, and re-starts — exactly the case the buggy exact-length version handled
    // wrong. Verified against an intentionally naive O(n^2) reference rather than hand-counted indices.
    let x = 12345;
    const bits = Array.from({ length: 400 }, () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return (x >> 16) % 2 === 0 ? U : D;
    });

    function reference(seqArr: Direction[], minLen: number) {
      const altLenAt = (i: number): number => {
        let len = 1;
        for (let j = i; j > 0 && seqArr[j] !== seqArr[j - 1]; j--) len++;
        return len;
      };
      let continued = 0;
      let broken = 0;
      for (let i = minLen; i < seqArr.length; i++) {
        if (altLenAt(i - 1) < minLen) continue;
        if (seqArr[i] !== seqArr[i - 1]) continued++;
        else broken++;
      }
      return { continued, broken, currentLength: altLenAt(seqArr.length - 1) };
    }

    for (const minLen of [2, 3, 4, 5]) {
      const ref = reference(bits, minLen);
      const result = alternationContinuationEstimate(bits, minLen);
      if (ref.currentLength < minLen) {
        expect(result).toBeNull();
        continue;
      }
      expect(result).not.toBeNull();
      expect(result!.length).toBe(ref.currentLength);
      expect(result!.sampleSize).toBe(ref.continued + ref.broken);
      expect(result!.pContinue).toBeCloseTo(ref.continued / (ref.continued + ref.broken), 10);
      expect(result!.expected).toBe(opposite(bits[bits.length - 1]!));
      expect(result!.pContinue! + result!.pBreak!).toBeCloseTo(1, 10);
    }
  });

  it('a break resets the current run length even though earlier qualifying points still count as samples', () => {
    // U D U D | D | U D U D U D  — the middle "D" repeats the prior "D", breaking the run; everything from
    // that "D" onward (D,U,D,U,D,U,D) alternates cleanly, so the *current* trailing run is 7 long, and both
    // the pre-break run and the post-break run contribute qualifying (>=3) historical samples.
    const s = seq('UDUD' + 'D' + 'UDUDUD');
    const result = alternationContinuationEstimate(s, 3)!;
    expect(result.length).toBe(7);
    expect(result.sampleSize).toBeGreaterThan(0);
  });

  it('a long live run without historical precedent at that exact length still gets sampled via shorter qualifying prefixes', () => {
    // Pure 10-long alternation: no *other* run in this series ever reaches length 10, but every position
    // from index 3 onward already had a qualifying (>=3) trailing run, so the "at least" definition still
    // produces a large sample from the run's own history — unlike the buggy exact-length version.
    const s = seq('UDUDUDUDUD');
    const result = alternationContinuationEstimate(s, 3)!;
    expect(result.length).toBe(10);
    expect(result.sampleSize).toBe(s.length - 3); // indices 3..9 all qualify
  });
});

describe('formatSequence', () => {
  it('renders UP/DOWN, most recent last, truncated to tail', () => {
    expect(formatSequence(seq('UUD'))).toBe('UP,UP,DOWN');
    expect(formatSequence(seq('UUUDDD'), 2)).toBe('DOWN,DOWN');
  });
});
