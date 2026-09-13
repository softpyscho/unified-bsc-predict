/**
 * Imports the CSV archives produced by bsc-predict-updater. Repeatable and duplicate-safe:
 *  - rows are validated (column count, integers, totalAmount == bull + bear) and malformed rows are reported;
 *  - duplicate epochs inside a file are collapsed when identical and excluded (reported) when they conflict,
 *    leaving the epoch to be filled from chain;
 *  - CSV data never overwrites chain-sourced final data (conflicts are counted, not applied);
 *  - original epochs are preserved as the round identifier.
 */
import type { RoundOutcome, RoundRecord, RoundStatus } from '@bsc/core';
import { deriveOutcome } from '@bsc/core';
import fs from 'node:fs/promises';
import type { ImportStats } from '../repositories/misc.js';
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';
import { PANCAKESWAP_V2_MAINNET } from './markets.js';

export type CsvFormat = 'PANCAKESWAP_V2' | 'PANCAKESWAP_V1' | 'PRDT';

const EXPECTED_COLUMNS: Record<CsvFormat, number> = { PANCAKESWAP_V2: 14, PANCAKESWAP_V1: 12, PRDT: 16 };
const DEFAULT_MARKET: Record<Exclude<CsvFormat, 'PANCAKESWAP_V2'>, string> = {
  PANCAKESWAP_V1: 'pancakeswap-bnb-v1',
  PRDT: 'prdt-bnb',
};

export interface ParsedRow {
  record: RoundRecord;
  status: RoundStatus;
  outcome: RoundOutcome;
  blocks?: { start: number | null; lock: number | null; close: number | null };
  extra?: Record<string, unknown>;
}

type ParseResult = { ok: ParsedRow } | { skip: 'empty' | 'incomplete' } | { error: string };

const INT = /^-?\d+$/;
const bool = (v: string) => v.trim().toLowerCase() === 'true';

export function parseRow(format: CsvFormat, fields: string[]): ParseResult {
  const n = EXPECTED_COLUMNS[format];
  // A trailing empty column (header "oracleCalled,") is tolerated.
  const cols = fields.length === n + 1 && fields[n] === '' ? fields.slice(0, n) : fields;
  if (cols.length !== n) return { error: `expected ${n} columns, got ${fields.length}` };
  const boolCols = format === 'PANCAKESWAP_V2' ? [13] : format === 'PANCAKESWAP_V1' ? [11] : [1, 2, 3];
  for (let i = 0; i < cols.length; i++) {
    if (boolCols.includes(i)) {
      if (!/^(true|false)$/i.test(cols[i]!)) return { error: `column ${i + 1} is not a boolean` };
    } else if (!INT.test(cols[i]!)) {
      return { error: `column ${i + 1} is not an integer` };
    }
  }
  const b = (i: number) => BigInt(cols[i]!);
  const num = (i: number) => Number(cols[i]!);
  const nz = (i: number) => (num(i) === 0 ? null : num(i));

  if (format === 'PANCAKESWAP_V2') {
    if (num(0) === 0 || num(1) === 0) return { skip: 'empty' };
    const record: RoundRecord = {
      epoch: num(0),
      startTime: nz(1),
      lockTime: nz(2),
      closeTime: nz(3),
      lockPrice: nz(4),
      closePrice: nz(5),
      lockOracleId: cols[6] === '0' ? null : cols[6]!,
      closeOracleId: cols[7] === '0' ? null : cols[7]!,
      totalAmount: b(8),
      bullAmount: b(9),
      bearAmount: b(10),
      rewardBaseCalAmount: b(11),
      rewardAmount: b(12),
      oracleCalled: bool(cols[13]!),
    };
    if (record.totalAmount !== record.bullAmount + record.bearAmount)
      return { error: 'totalAmount != bullAmount + bearAmount' };
    // The updater only archived rounds that were ended or past close + buffer, so both states are final.
    const status: RoundStatus = record.oracleCalled ? 'ENDED' : 'CANCELLED';
    return { ok: { record, status, outcome: deriveOutcome(record, status)! } };
  }

  if (format === 'PANCAKESWAP_V1') {
    if (num(1) === 0) return { skip: 'empty' };
    const record: RoundRecord = {
      epoch: num(0),
      startTime: null,
      lockTime: null,
      closeTime: null,
      lockPrice: nz(4),
      closePrice: nz(5),
      lockOracleId: null,
      closeOracleId: null,
      totalAmount: b(6),
      bullAmount: b(7),
      bearAmount: b(8),
      rewardBaseCalAmount: b(9),
      rewardAmount: b(10),
      oracleCalled: bool(cols[11]!),
    };
    if (record.totalAmount !== record.bullAmount + record.bearAmount)
      return { error: 'totalAmount != bullAmount + bearAmount' };
    // V1 is permanently paused: rounds that were never ended can never be ended.
    const status: RoundStatus = record.oracleCalled ? 'ENDED' : 'CANCELLED';
    return {
      ok: {
        record,
        status,
        outcome: deriveOutcome(record, status)!,
        blocks: { start: nz(1), lock: nz(2), close: nz(3) },
      },
    };
  }

  // PRDT: epoch,genesis,completed,cancelled,bull,bear,rewardBaseCal,reward,treasury,bullBonus,bearBonus,lock,close,start,lockTs,closeTs
  const completed = bool(cols[2]!);
  const cancelled = bool(cols[3]!);
  if (!completed && !cancelled) return { skip: 'incomplete' };
  const record: RoundRecord = {
    epoch: num(0),
    startTime: nz(13),
    lockTime: nz(14),
    closeTime: nz(15),
    lockPrice: nz(11),
    closePrice: nz(12),
    lockOracleId: null,
    closeOracleId: null,
    totalAmount: b(4) + b(5),
    bullAmount: b(4),
    bearAmount: b(5),
    rewardBaseCalAmount: b(6),
    rewardAmount: b(7),
    oracleCalled: completed,
  };
  const status: RoundStatus = cancelled ? 'CANCELLED' : 'ENDED';
  return {
    ok: {
      record,
      status,
      outcome: deriveOutcome(record, status)!,
      extra: {
        genesis: bool(cols[1]!),
        treasuryAmount: cols[8],
        bullBonusAmount: cols[9],
        bearBonusAmount: cols[10],
      },
    },
  };
}

export async function readSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${source}`);
    return res.text();
  }
  return fs.readFile(source, 'utf8');
}

export interface ImportReport extends ImportStats {
  importRunId: number;
  market: string;
  format: CsvFormat;
  source: string;
  skippedEmpty: number;
  incomplete: number;
  conflictingEpochs: number[];
  malformedLines: { line: number; reason: string }[];
  dbConflictEpochs: number[];
  firstEpoch: number | null;
  lastEpoch: number | null;
  durationMs: number;
}

const REPORT_LIMIT = 50;
const TX_BATCH = 5_000;

export class CsvImporter {
  constructor(private readonly ctx: Ctx) {}

  async import(opts: {
    format: CsvFormat;
    source: string;
    marketSlug?: string;
    onProgress?: (done: number, total: number) => void;
  }): Promise<ImportReport> {
    const started = Date.now();
    const { repos, config } = this.ctx;
    const slug =
      opts.marketSlug ?? (opts.format === 'PANCAKESWAP_V2' ? config.marketSlug : DEFAULT_MARKET[opts.format]);
    const market = repos.markets.bySlug(slug);
    if (!market) throw new Error(`unknown market "${slug}" (run migrations/seed first)`);
    if (
      opts.format === 'PANCAKESWAP_V2' &&
      market.contractAddress.toLowerCase() !== PANCAKESWAP_V2_MAINNET.toLowerCase()
    ) {
      throw new Error(
        `the bsc-predict-updater V2 archive belongs to ${PANCAKESWAP_V2_MAINNET}, but market "${slug}" is ${market.contractAddress}`,
      );
    }
    if (opts.format !== 'PANCAKESWAP_V2' && market.protocol !== opts.format) {
      throw new Error(`format ${opts.format} does not match market "${slug}" (${market.protocol})`);
    }

    const text = await readSource(opts.source);
    const lines = text.split(/\r?\n/);
    const runId = repos.sync.startImport(market.id, opts.source);
    const stats: ImportStats = {
      rowsRead: 0,
      inserted: 0,
      unchanged: 0,
      duplicatesIdentical: 0,
      duplicatesConflicting: 0,
      malformed: 0,
      conflictsWithDb: 0,
    };
    const malformedLines: { line: number; reason: string }[] = [];
    const firstSeen = new Map<number, { raw: string; parsed: ParsedRow }>();
    const conflicting = new Set<number>();
    let skippedEmpty = 0;
    let incomplete = 0;

    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i]!.trim();
      if (raw === '') continue;
      stats.rowsRead++;
      const parsed = parseRow(opts.format, raw.split(','));
      if ('error' in parsed) {
        stats.malformed++;
        if (malformedLines.length < REPORT_LIMIT) malformedLines.push({ line: i + 1, reason: parsed.error });
        continue;
      }
      if ('skip' in parsed) {
        if (parsed.skip === 'empty') skippedEmpty++;
        else incomplete++;
        continue;
      }
      const epoch = parsed.ok.record.epoch;
      const prior = firstSeen.get(epoch);
      if (prior) {
        if (prior.raw === raw) stats.duplicatesIdentical++;
        else {
          stats.duplicatesConflicting++;
          conflicting.add(epoch);
        }
        continue;
      }
      firstSeen.set(epoch, { raw, parsed: parsed.ok });
    }

    const epochs = [...firstSeen.keys()].filter((e) => !conflicting.has(e)).sort((a, b) => a - b);
    const dbConflictEpochs: number[] = [];
    for (let start = 0; start < epochs.length; start += TX_BATCH) {
      const slice = epochs.slice(start, start + TX_BATCH);
      repos.db.tx(() => {
        for (const epoch of slice) {
          const row = firstSeen.get(epoch)!.parsed;
          const res = repos.rounds.upsert(market.id, {
            record: row.record,
            status: row.status,
            outcome: row.outcome,
            isFinal: true,
            source: 'CSV_IMPORT',
            treasuryFeeBps: market.treasuryFeeBps,
            blocks: row.blocks,
            extra: row.extra ?? null,
          });
          if (res.result === 'inserted' || res.result === 'finalized' || res.result === 'updated')
            stats.inserted++;
          else if (res.result === 'conflict') {
            stats.conflictsWithDb++;
            if (dbConflictEpochs.length < REPORT_LIMIT) dbConflictEpochs.push(epoch);
          } else stats.unchanged++;
        }
      });
      opts.onProgress?.(Math.min(start + TX_BATCH, epochs.length), epochs.length);
      await new Promise((r) => setImmediate(r));
    }

    const report: ImportReport = {
      ...stats,
      importRunId: runId,
      market: market.slug,
      format: opts.format,
      source: opts.source,
      skippedEmpty,
      incomplete,
      conflictingEpochs: [...conflicting].sort((a, b) => a - b).slice(0, REPORT_LIMIT),
      malformedLines,
      dbConflictEpochs,
      firstEpoch: epochs[0] ?? null,
      lastEpoch: epochs.at(-1) ?? null,
      durationMs: Date.now() - started,
    };
    repos.sync.finishImport(runId, stats, report);
    this.ctx.audit.record({
      component: 'csv-import',
      severity: stats.malformed + stats.duplicatesConflicting + stats.conflictsWithDb > 0 ? 'WARN' : 'INFO',
      type: AuditType.HISTORY_IMPORTED,
      marketId: market.id,
      message: `imported ${stats.inserted} rounds into ${market.slug} (${stats.rowsRead} rows, ${stats.duplicatesIdentical} identical duplicates, ${stats.duplicatesConflicting} conflicting duplicates, ${stats.malformed} malformed, ${stats.conflictsWithDb} conflicts with existing data)`,
      metadata: { ...report, malformedLines: report.malformedLines.slice(0, 10) },
    });
    return report;
  }
}
