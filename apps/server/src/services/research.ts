/**
 * Research engine: pre-registered experiments over the stored rounds and pool events.
 *
 * An experiment's specification is resolved and frozen at registration; results are immutable once it finishes.
 * Every hypothesis tested goes into an append-only ledger, so significance can be corrected across everything that
 * was ever tried, not just within one run. "No edge found" is recorded like any other result. Studies run on a
 * worker thread in the built server, so research never delays the trading loop.
 */
import type { StudyFamily } from '@bsc/core';
import {
  RESEARCH_CODE_VERSION,
  STUDY_FAMILIES,
  benjaminiHochberg,
  bnbToWei,
  weiToBnbString,
} from '@bsc/core';
import { z } from 'zod';
import type { Experiment, ResearchTest } from '../repositories/index.js';
import { runStudyJob } from '../research/runner.js';
import { errorMessage } from '../util/json.js';
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';
import type { MarketService } from './markets.js';

const bnbAmount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,18})?$/, 'must be a BNB amount such as 0.01');
const positiveBnb = bnbAmount.refine((v) => bnbToWei(v) > 0n, 'must be positive');

const specInput = z
  .object({
    families: z
      .array(z.enum(['baseline', 'sequence', 'hour', 'pool']))
      .min(1)
      .optional(),
    fromEpoch: z.number().int().nonnegative().optional(),
    toEpoch: z.number().int().nonnegative().optional(),
    trainFraction: z.number().min(0.2).max(0.9).optional(),
    decisionOffsets: z.array(z.number().int().min(1).max(290)).min(1).max(6).optional(),
    stakeBnb: positiveBnb.optional(),
    gasBetBnb: bnbAmount.optional(),
    gasClaimBnb: bnbAmount.optional(),
    alpha: z.number().gt(0).max(0.2).optional(),
  })
  .strict()
  .refine((s) => s.fromEpoch === undefined || s.toEpoch === undefined || s.fromEpoch <= s.toEpoch, {
    message: 'fromEpoch must not exceed toEpoch',
  });

const registerInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  spec: specInput.default({}),
});

/** A registered experiment's frozen specification: every default resolved. */
export interface ExperimentSpec {
  families: StudyFamily[];
  fromEpoch: number | null;
  toEpoch: number | null;
  trainFraction: number;
  decisionOffsets: number[];
  stakeBnb: string;
  gasBetBnb: string;
  gasClaimBnb: string;
  alpha: number;
}

export interface ExperimentView extends Experiment {
  tests: (ResearchTest & { pAdjGlobal: number })[];
  /** Hypotheses of this experiment still significant after correcting across the whole ledger. */
  globalSurvivors: number;
}

export class ResearchService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: Ctx,
    private readonly markets: MarketService,
  ) {}

  async register(input: unknown): Promise<Experiment> {
    const { name, description, spec } = registerInput.parse(input);
    const { config } = this.ctx;
    const defaultStake = config.risk.minStakeWei > 0n ? config.risk.minStakeWei : config.defaultBetWei;
    const resolved: ExperimentSpec = {
      families: spec.families ?? [...STUDY_FAMILIES],
      fromEpoch: spec.fromEpoch ?? null,
      toEpoch: spec.toEpoch ?? null,
      trainFraction: spec.trainFraction ?? 0.7,
      decisionOffsets: spec.decisionOffsets ?? [30, 10],
      stakeBnb: spec.stakeBnb ?? weiToBnbString(defaultStake),
      gasBetBnb: spec.gasBetBnb ?? weiToBnbString(config.simulatedGasPerBetWei),
      gasClaimBnb: spec.gasClaimBnb ?? weiToBnbString(config.simulatedGasPerClaimWei),
      alpha: spec.alpha ?? 0.05,
    };
    return this.ctx.repos.research.register({
      name,
      description: description ?? null,
      spec: resolved,
      codeVersion: RESEARCH_CODE_VERSION,
    });
  }

  /** Runs a registered experiment. Runs are serialised; a finished experiment cannot be run again. */
  run(id: number): Promise<ExperimentView> {
    const next = this.queue.then(() => this.execute(id));
    this.queue = next.catch(() => undefined);
    return next;
  }

  runInBackground(id: number): void {
    void this.run(id).catch((err: unknown) =>
      this.ctx.log.app.error({ err, experimentId: id }, 'research experiment failed'),
    );
  }

  private async execute(id: number): Promise<ExperimentView> {
    const { repos, audit } = this.ctx;
    const exp = await repos.research.get(id);
    if (!exp) throw new Error(`experiment ${id} not found`);
    if (!(await repos.research.markRunning(id)))
      throw new Error(`experiment ${id} is ${exp.status}; register a new experiment to run it again`);
    const spec = exp.spec as ExperimentSpec;
    try {
      const market = this.markets.tradable();
      const rounds = await repos.research.roundColumns(
        market.id,
        market.treasuryFeeBps,
        spec.fromEpoch,
        spec.toEpoch,
      );
      const events = spec.families.includes('pool')
        ? await repos.research.eventColumns(market.id, spec.fromEpoch, spec.toEpoch)
        : null;
      const poolEvents = events?.n ?? 0;
      const result = await runStudyJob({
        rounds,
        events,
        options: {
          cost: {
            stakeWei: bnbToWei(spec.stakeBnb),
            gasBetWei: bnbToWei(spec.gasBetBnb),
            gasClaimWei: bnbToWei(spec.gasClaimBnb),
          },
          families: spec.families,
          trainFraction: spec.trainFraction,
          decisionOffsets: spec.decisionOffsets,
          alpha: spec.alpha,
        },
      });
      const dataSummary = {
        market: market.slug,
        rounds: result.rounds,
        fromEpoch: result.fromEpoch,
        toEpoch: result.toEpoch,
        poolEvents,
        poolSampleRounds: result.pools?.sampleRounds ?? 0,
      };
      await repos.research.finish(
        id,
        {
          verdict: result.verdict,
          rulesSearched: result.rules.length,
          edges: result.edges.length,
          survivors: result.survivors.length,
          dataSummary,
          result,
        },
        result.hypotheses,
      );
      await audit.record({
        component: 'research',
        severity: 'INFO',
        type: AuditType.RESEARCH_COMPLETED,
        message:
          `experiment #${id} "${exp.name}": ${result.verdict} — ${result.survivors.length}/${result.hypotheses.length} ` +
          `hypotheses survive BH, ${result.edges.length}/${result.rules.length} rules are edge candidates ` +
          `(${result.rounds} rounds)`,
        metadata: { experimentId: id, verdict: result.verdict },
      });
    } catch (err) {
      await repos.research.fail(id, errorMessage(err));
      await audit.record({
        component: 'research',
        severity: 'ERROR',
        type: AuditType.RESEARCH_FAILED,
        message: `experiment #${id} "${exp.name}" failed: ${errorMessage(err)}`,
        metadata: { experimentId: id },
      });
      throw err;
    }
    return (await this.view(id))!;
  }

  async list(limit = 100): Promise<Experiment[]> {
    return this.ctx.repos.research.list(limit);
  }

  async view(id: number): Promise<ExperimentView | null> {
    const exp = await this.ctx.repos.research.get(id);
    if (!exp) return null;
    const adjusted = await this.globalAdjusted();
    const tests = (await this.ctx.repos.research.tests(id)).map((t) => ({
      ...t,
      pAdjGlobal: adjusted.get(t.id) ?? 1,
    }));
    const alpha = (exp.spec as ExperimentSpec).alpha;
    return { ...exp, tests, globalSurvivors: tests.filter((t) => t.pAdjGlobal < alpha).length };
  }

  /** Benjamini–Hochberg across every hypothesis ever tested. */
  async ledger(alpha = 0.05) {
    const tests = await this.ctx.repos.research.tests();
    const adjusted = benjaminiHochberg(tests.map((t) => t.pRaw));
    const rows = tests.map((t, i) => ({ ...t, pAdjGlobal: adjusted[i]! }));
    return {
      totalTests: rows.length,
      experiments: new Set(rows.map((r) => r.experimentId)).size,
      alpha,
      survivors: rows.filter((r) => r.pAdjGlobal < alpha).sort((a, b) => a.pAdjGlobal - b.pAdjGlobal),
    };
  }

  private async globalAdjusted(): Promise<Map<number, number>> {
    const tests = await this.ctx.repos.research.tests();
    const adjusted = benjaminiHochberg(tests.map((t) => t.pRaw));
    return new Map(tests.map((t, i) => [t.id, adjusted[i]!]));
  }

  async failInterrupted(): Promise<number> {
    return this.ctx.repos.research.failInterrupted();
  }

  async shutdown(): Promise<void> {
    await this.queue;
  }
}
