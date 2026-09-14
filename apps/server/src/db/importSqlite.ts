/**
 * One-time import of a legacy SQLite database (the app's store before the move to PostgreSQL) into a freshly
 * migrated Postgres/PGlite database. Rows keep their ids, so every foreign key and every reference in logs and
 * reports stays valid; identity sequences are advanced past the imported ids afterwards.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlValue } from './database.js';

/** Parents before children, so foreign keys are satisfied row by row. */
const TABLES = [
  'markets',
  'rounds',
  'round_corrections',
  'sync_state',
  'import_runs',
  'wallets',
  'strategies',
  'claims',
  'trades',
  'trade_events',
  'strategy_decisions',
  'portfolio_snapshots',
  'audit_events',
  'backtest_runs',
] as const;
const ROWS_PER_INSERT = 500;
const INSERTS_PER_TX = 20;

export async function importSqlite(
  db: Db,
  file: string,
  onProgress?: (table: string, done: number, total: number) => void,
): Promise<{ table: string; rows: number }[]> {
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    const seeded = (await db.get<{ n: number }>('SELECT count(*) AS n FROM markets'))!.n;
    if (seeded > 0)
      throw new Error(
        'the target database already contains data; import into a new, empty database (e.g. delete data/pg first)',
      );
    const srcTables = new Set(
      (src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    const out: { table: string; rows: number }[] = [];
    for (const table of TABLES) {
      if (!srcTables.has(table)) {
        out.push({ table, rows: 0 });
        continue;
      }
      const target = new Set(
        (
          await db.all<{ column_name: string }>(
            'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
            [table],
          )
        ).map((r) => r.column_name),
      );
      const columns = (src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((c) => c.name)
        .filter((c) => target.has(c));
      const total = (src.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      const rows = src
        .prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid`)
        .iterate() as Iterable<Record<string, SqlValue>>;
      let done = 0;
      let batch: Record<string, SqlValue>[] = [];
      const flush = async () => {
        if (batch.length === 0) return;
        const values: SqlValue[] = [];
        const tuples = batch.map(
          (row) =>
            `(${columns
              .map((c) => {
                values.push(row[c] ?? null);
                return '?';
              })
              .join(', ')})`,
        );
        await db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values);
        done += batch.length;
        batch = [];
        onProgress?.(table, done, total);
      };
      const iterator = rows[Symbol.iterator]();
      let finished = false;
      while (!finished) {
        await db.tx(async () => {
          for (let inserts = 0; inserts < INSERTS_PER_TX; inserts++) {
            for (let n = 0; n < ROWS_PER_INSERT; n++) {
              const next = iterator.next();
              if (next.done) {
                finished = true;
                break;
              }
              batch.push(next.value);
            }
            await flush();
            if (finished) break;
          }
        });
      }
      out.push({ table, rows: done });
    }

    if (srcTables.has('bot_state')) {
      const b = src.prepare('SELECT * FROM bot_state WHERE id = 1').get() as
        Record<string, SqlValue> | undefined;
      if (b) {
        await db.run(
          `UPDATE bot_state SET status = ?, status_reason = ?, live_armed = ?, live_armed_at = ?,
             consecutive_failures = ?, updated_at = ? WHERE id = 1`,
          [b.status, b.status_reason, b.live_armed, b.live_armed_at, b.consecutive_failures, b.updated_at],
        );
      }
    }
    for (const table of TABLES) {
      if (table === 'sync_state') continue; // keyed by market_id, no identity column
      await db.exec(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT max(id) FROM ${table}), 0) + 1, false)`,
      );
    }
    return out;
  } finally {
    src.close();
  }
}
