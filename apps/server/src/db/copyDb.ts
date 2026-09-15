/**
 * Copies every table of one database into another, empty, migrated one: e.g. the embedded PGlite store into a
 * Supabase Postgres. Rows keep their ids, so every foreign key and every id in logs and reports stays valid;
 * identity sequences are advanced past the copied ids afterwards. Append-only triggers only reject updates and
 * deletes, so plain inserts pass them.
 */
import type { Db, SqlValue } from './database.js';

/** Parents before children, so foreign keys hold row by row. */
export const COPY_TABLES = [
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
  'round_pool_events',
  'pool_event_sync',
  'pool_event_gaps',
  'research_experiments',
  'research_tests',
  'shadow_checks',
] as const;

/** Tables keyed by market_id rather than an identity column. */
const KEYED_BY_MARKET = new Set<string>(['sync_state', 'pool_event_sync']);
const ROWS_PER_PAGE = 2_000;
/** Postgres allows 65,535 bind parameters per statement. */
const MAX_PARAMS = 60_000;

async function columnsOf(db: Db, table: string): Promise<string[]> {
  return (
    await db.all<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`,
      [table],
    )
  ).map((r) => r.column_name);
}

export async function copyDatabase(
  source: Db,
  target: Db,
  onProgress?: (table: string, done: number, total: number) => void,
): Promise<{ table: string; rows: number }[]> {
  const existing = (await target.get<{ n: number }>('SELECT count(*) AS n FROM markets'))!.n;
  if (existing > 0)
    throw new Error('the target database already contains data; copy into a new, empty database');
  const out: { table: string; rows: number }[] = [];
  for (const table of COPY_TABLES) {
    const targetCols = new Set(await columnsOf(target, table));
    const columns = (await columnsOf(source, table)).filter((c) => targetCols.has(c));
    const key = KEYED_BY_MARKET.has(table) ? 'market_id' : 'id';
    const total = (await source.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
    const perInsert = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
    let after = -1;
    let done = 0;
    for (;;) {
      const page = await source.all<Record<string, SqlValue>>(
        `SELECT ${columns.join(', ')} FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`,
        [after, ROWS_PER_PAGE],
      );
      if (page.length === 0) break;
      await target.tx(async () => {
        for (let i = 0; i < page.length; i += perInsert) {
          const values: SqlValue[] = [];
          const tuples = page.slice(i, i + perInsert).map((row) => {
            for (const c of columns) values.push(row[c] ?? null);
            return `(${columns.map(() => '?').join(', ')})`;
          });
          await target.run(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
            values,
          );
        }
      });
      done += page.length;
      after = Number(page.at(-1)![key]);
      onProgress?.(table, done, total);
    }
    out.push({ table, rows: done });
  }

  const bot = await source.get<Record<string, SqlValue>>('SELECT * FROM bot_state WHERE id = 1');
  if (bot)
    await target.run(
      `UPDATE bot_state SET status = ?, status_reason = ?, live_armed = ?, live_armed_at = ?,
         consecutive_failures = ?, updated_at = ? WHERE id = 1`,
      [
        bot.status,
        bot.status_reason,
        bot.live_armed,
        bot.live_armed_at,
        bot.consecutive_failures,
        bot.updated_at,
      ],
    );
  const applied = await source.all<{ id: number; name: string; applied_at: string }>(
    'SELECT id, name, applied_at FROM schema_migrations ORDER BY id',
  );
  const targetApplied = new Set(
    (await target.all<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => r.id),
  );
  const missing = applied.filter((m) => !targetApplied.has(m.id));
  if (missing.length > 0)
    throw new Error(`target is missing migrations ${missing.map((m) => m.id).join(', ')}; migrate it first`);

  for (const table of COPY_TABLES) {
    if (KEYED_BY_MARKET.has(table)) continue;
    await target.exec(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT max(id) FROM ${table}), 0) + 1, false)`,
    );
  }
  return out;
}
