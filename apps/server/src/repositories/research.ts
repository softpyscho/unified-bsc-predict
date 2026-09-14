import type { Direction, Hypothesis, RoundOutcome } from '@bsc/core';
import type { Db, SqlValue } from '../db/database.js';
import { nowIso } from '../db/database.js';
import type { EventColumns, RoundColumns } from '../research/columns.js';
import { allocEventColumns, allocRoundColumns, setEvent, setRound } from '../research/columns.js';

export type ExperimentStatus = 'REGISTERED' | 'RUNNING' | 'DONE' | 'FAILED';

export interface Experiment {
  id: number;
  name: string;
  description: string | null;
  spec: unknown;
  status: ExperimentStatus;
  verdict: 'NO_EDGE' | 'EDGE_CANDIDATE' | null;
  hypothesesTested: number | null;
  survivors: number | null;
  rulesSearched: number | null;
  edges: number | null;
  dataSummary: unknown;
  result: unknown;
  error: string | null;
  codeVersion: string;
  registeredAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ResearchTest {
  id: number;
  experimentId: number;
  hypothesisId: string;
  family: string;
  label: string;
  n: number;
  estimate: number;
  baseline: number;
  pRaw: number;
  pAdjExperiment: number;
}

interface ExperimentRow {
  id: number;
  name: string;
  description: string | null;
  spec: string;
  status: ExperimentStatus;
  verdict: 'NO_EDGE' | 'EDGE_CANDIDATE' | null;
  hypotheses_tested: number | null;
  survivors: number | null;
  rules_searched: number | null;
  edges: number | null;
  data_summary: string | null;
  result: string | null;
  error: string | null;
  code_version: string;
  registered_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Rows per query while loading research data; each page yields to the event loop. */
const PAGE = 10_000;
const TESTS_PER_INSERT = 500;
const LIST_COLUMNS = `id, name, description, spec, status, verdict, hypotheses_tested, survivors, rules_searched, edges,
  data_summary, NULL AS result, error, code_version, registered_at, started_at, finished_at`;
const ROUND_WHERE = `market_id = ? AND is_final = 1 AND outcome IS NOT NULL AND lock_time IS NOT NULL`;

const parse = (v: string | null): unknown => (v === null ? null : JSON.parse(v));
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));
const toExperiment = (r: ExperimentRow): Experiment => ({
  id: r.id,
  name: r.name,
  description: r.description,
  spec: parse(r.spec),
  status: r.status,
  verdict: r.verdict,
  hypothesesTested: r.hypotheses_tested,
  survivors: r.survivors,
  rulesSearched: r.rules_searched,
  edges: r.edges,
  dataSummary: parse(r.data_summary),
  result: parse(r.result),
  error: r.error,
  codeVersion: r.code_version,
  registeredAt: r.registered_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export class ResearchRepo {
  constructor(private readonly db: Db) {}

  async register(e: {
    name: string;
    description: string | null;
    spec: unknown;
    codeVersion: string;
  }): Promise<Experiment> {
    const id = await this.db.insert(
      `INSERT INTO research_experiments (name, description, spec, status, code_version)
       VALUES (?, ?, ?, 'REGISTERED', ?)`,
      [e.name, e.description, JSON.stringify(e.spec), e.codeVersion],
    );
    return (await this.get(id))!;
  }

  async get(id: number): Promise<Experiment | undefined> {
    const r = await this.db.get<ExperimentRow>('SELECT * FROM research_experiments WHERE id = ?', [id]);
    return r ? toExperiment(r) : undefined;
  }

  /** Newest first, without the (large) result payload. */
  async list(limit = 100): Promise<Experiment[]> {
    return (
      await this.db.all<ExperimentRow>(
        `SELECT ${LIST_COLUMNS} FROM research_experiments ORDER BY id DESC LIMIT ?`,
        [limit],
      )
    ).map(toExperiment);
  }

  async markRunning(id: number): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE research_experiments SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'REGISTERED'`,
      [nowIso(), id],
    );
    return res.changes === 1;
  }

  /** Stores the tested hypotheses in the ledger and the result, atomically. */
  async finish(
    id: number,
    r: {
      verdict: 'NO_EDGE' | 'EDGE_CANDIDATE';
      rulesSearched: number;
      edges: number;
      survivors: number;
      dataSummary: unknown;
      result: unknown;
    },
    hypotheses: readonly Hypothesis[],
  ): Promise<void> {
    await this.db.tx(async () => {
      for (let i = 0; i < hypotheses.length; i += TESTS_PER_INSERT) {
        const values: SqlValue[] = [];
        const tuples = hypotheses.slice(i, i + TESTS_PER_INSERT).map((h) => {
          values.push(id, h.id, h.family, h.label, h.n, h.estimate, h.baseline, h.pRaw, h.pAdj ?? 1);
          return '(?, ?, ?, ?, ?, ?, ?, ?, ?)';
        });
        await this.db.run(
          `INSERT INTO research_tests
             (experiment_id, hypothesis_id, family, label, n, estimate, baseline, p_raw, p_adj_experiment)
           VALUES ${tuples.join(', ')}`,
          values,
        );
      }
      await this.db.run(
        `UPDATE research_experiments SET status = 'DONE', verdict = ?, hypotheses_tested = ?, survivors = ?,
           rules_searched = ?, edges = ?, data_summary = ?, result = ?, finished_at = ?
         WHERE id = ? AND status = 'RUNNING'`,
        [
          r.verdict,
          hypotheses.length,
          r.survivors,
          r.rulesSearched,
          r.edges,
          JSON.stringify(r.dataSummary),
          JSON.stringify(r.result),
          nowIso(),
          id,
        ],
      );
    });
  }

  async fail(id: number, error: string): Promise<void> {
    await this.db.run(
      `UPDATE research_experiments SET status = 'FAILED', error = ?, finished_at = ?
       WHERE id = ? AND status IN ('REGISTERED','RUNNING')`,
      [error.slice(0, 2000), nowIso(), id],
    );
  }

  /** Experiments left RUNNING by a process that stopped mid-run. */
  async failInterrupted(): Promise<number> {
    return (
      await this.db.run(
        `UPDATE research_experiments SET status = 'FAILED', error = 'interrupted by a restart', finished_at = ?
         WHERE status = 'RUNNING'`,
        [nowIso()],
      )
    ).changes;
  }

  async tests(experimentId?: number): Promise<ResearchTest[]> {
    return this.db.all<ResearchTest>(
      `SELECT id, experiment_id AS "experimentId", hypothesis_id AS "hypothesisId", family, label, n, estimate,
              baseline, p_raw AS "pRaw", p_adj_experiment AS "pAdjExperiment"
       FROM research_tests ${experimentId === undefined ? '' : 'WHERE experiment_id = ?'} ORDER BY id`,
      experimentId === undefined ? [] : [experimentId],
    );
  }

  /**
   * Final rounds in epoch order as transferable columns. Final rounds never change, so the set is fixed by the
   * count taken first; rows are loaded in pages that yield to the event loop between queries.
   */
  async roundColumns(
    marketId: number,
    feeBps: number,
    fromEpoch: number | null,
    toEpoch: number | null,
  ): Promise<RoundColumns> {
    const range = [marketId, fromEpoch ?? 0, toEpoch ?? Number.MAX_SAFE_INTEGER];
    const { n, last } = (await this.db.get<{ n: number; last: number | null }>(
      `SELECT count(*) AS n, max(epoch) AS last FROM rounds WHERE ${ROUND_WHERE} AND epoch >= ? AND epoch <= ?`,
      range,
    ))!;
    const cols = allocRoundColumns(n, feeBps);
    let after = (fromEpoch ?? 0) - 1;
    let i = 0;
    while (i < n) {
      const page = await this.db.all<{
        epoch: number;
        lock_time: number;
        total_amount: string;
        bull_amount: string;
        bear_amount: string;
        reward_amount: string;
        reward_base_cal_amount: string;
        outcome: RoundOutcome;
      }>(
        `SELECT epoch, lock_time, total_amount, bull_amount, bear_amount, reward_amount, reward_base_cal_amount, outcome
         FROM rounds WHERE ${ROUND_WHERE} AND epoch > ? AND epoch <= ? ORDER BY epoch LIMIT ?`,
        [marketId, after, last, PAGE],
      );
      if (page.length === 0) break;
      for (const r of page) {
        if (i >= n) break;
        setRound(cols, i++, {
          epoch: r.epoch,
          lockTime: r.lock_time,
          outcome: r.outcome,
          total: BigInt(r.total_amount),
          bull: BigInt(r.bull_amount),
          bear: BigInt(r.bear_amount),
          reward: BigInt(r.reward_amount),
          rewardBase: BigInt(r.reward_base_cal_amount),
        });
      }
      after = page.at(-1)!.epoch;
      await yieldToLoop();
    }
    return { ...cols, n: i };
  }

  /** Pool events for the epoch range as transferable columns (paged by id; order within a round is irrelevant). */
  async eventColumns(
    marketId: number,
    fromEpoch: number | null,
    toEpoch: number | null,
  ): Promise<EventColumns> {
    const range = [marketId, fromEpoch ?? 0, toEpoch ?? Number.MAX_SAFE_INTEGER];
    const where = 'market_id = ? AND epoch >= ? AND epoch <= ?';
    const { n, last } = (await this.db.get<{ n: number; last: number | null }>(
      `SELECT count(*) AS n, max(id) AS last FROM round_pool_events WHERE ${where}`,
      range,
    ))!;
    const cols = allocEventColumns(n);
    let after = 0;
    let i = 0;
    while (i < n) {
      const page = await this.db.all<{
        id: number;
        epoch: number;
        block_time: number;
        direction: Direction;
        amount: string;
      }>(
        `SELECT id, epoch, block_time, direction, amount FROM round_pool_events
         WHERE ${where} AND id > ? AND id <= ? ORDER BY id LIMIT ?`,
        [...range, after, last, PAGE],
      );
      if (page.length === 0) break;
      for (const e of page) {
        if (i >= n) break;
        setEvent(cols, i++, {
          epoch: e.epoch,
          time: e.block_time,
          side: e.direction,
          amount: BigInt(e.amount),
        });
      }
      after = page.at(-1)!.id;
      await yieldToLoop();
    }
    return { ...cols, n: i };
  }
}
