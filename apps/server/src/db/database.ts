/**
 * PostgreSQL access. One API over two engines running the same SQL and migrations:
 *  - `postgres://…` / `postgresql://…` → node-postgres pool (local Postgres, Supabase);
 *  - anything else → embedded PGlite (a data directory, or `memory:` for tests).
 * The active transaction lives in AsyncLocalStorage, so every query issued inside `tx()` — however deep in the
 * call stack — runs on that transaction's connection without passing a handle around.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export type SqlValue = string | number | bigint | boolean | null | undefined;
export type Params = Record<string, SqlValue> | SqlValue[];

interface Executor {
  query(sql: string, values: unknown[]): Promise<{ rows: unknown[]; affected: number }>;
  exec(sql: string): Promise<void>;
}

const INT8 = 20;
const NUMERIC = 1700;
const asNumber = (v: string) => Number(v);
const asString = (v: string) => v;

/** Serialises whole transactions and standalone queries on a single-session engine. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface Compiled {
  text: string;
  order: (number | string)[];
}

/** Rewrites `?` and `:name` placeholders to `$n`, leaving literals, identifiers, casts and bodies untouched. */
function compile(sql: string): Compiled {
  let out = '';
  const order: (number | string)[] = [];
  const named = new Map<string, number>();
  let positional = 0;
  let i = 0;
  const copyUntil = (end: number) => {
    out += sql.slice(i, end);
    i = end;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      copyUntil(Math.min(sql.length, j + 1));
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      copyUntil(nl === -1 ? sql.length : nl);
    } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const close = sql.indexOf(tag, i + tag.length);
      copyUntil(close === -1 ? sql.length : close + tag.length);
    } else if (c === '?') {
      order.push(positional++);
      out += `$${order.length}`;
      i++;
    } else if (c === ':' && sql[i + 1] === ':') {
      out += '::';
      i += 2;
    } else if (c === ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))![0];
      if (!named.has(name)) {
        order.push(name);
        named.set(name, order.length);
      }
      out += `$${named.get(name)}`;
      i += name.length + 1;
    } else {
      out += c;
      i++;
    }
  }
  return { text: out, order };
}

function toValue(v: SqlValue): unknown {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * Embedded PGlite is single-process: a second process opening the same directory would corrupt it. A lock file
 * next to the directory holds the owner's pid; a lock left by a process that has exited is taken over.
 */
function acquireDirLock(dir: string): () => void {
  const file = `${dir}.lock`;
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (pid > 0 && processAlive(pid))
        throw new Error(
          `database directory ${dir} is in use by process ${pid}. Embedded PGlite allows one process at a time: ` +
            'stop that process first, or use a postgres:// DATABASE_URL for concurrent access',
          { cause: err },
        );
      fs.rmSync(file, { force: true });
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class Db {
  private readonly current = new AsyncLocalStorage<Executor>();
  private readonly compiled = new Map<string, Compiled>();
  private savepoints = 0;

  private constructor(
    readonly url: string,
    readonly engine: 'pglite' | 'postgres',
    private readonly base: Executor,
    private readonly transaction: <T>(fn: (e: Executor) => Promise<T>) => Promise<T>,
    private readonly closeEngine: () => Promise<void>,
  ) {}

  static async open(url: string): Promise<Db> {
    if (/^postgres(ql)?:\/\//.test(url)) {
      const pool = new pg.Pool({
        connectionString: url,
        max: 10,
        types: {
          getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
            oid === INT8
              ? asNumber
              : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
        },
      });
      const wrap = (q: pg.Pool | pg.PoolClient): Executor => ({
        async query(sql, values) {
          const r = await q.query(sql, values);
          return { rows: r.rows, affected: r.rowCount ?? 0 };
        },
        async exec(sql) {
          await q.query(sql);
        },
      });
      return new Db(
        url,
        'postgres',
        wrap(pool),
        async (fn) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const result = await fn(wrap(client));
            await client.query('COMMIT');
            return result;
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }
        },
        () => pool.end(),
      );
    }

    const dir = url.replace(/^pglite:/, '');
    const memory = dir === 'memory:' || dir === ':memory:';
    if (!memory) fs.mkdirSync(path.resolve(dir), { recursive: true });
    const release = memory ? () => undefined : acquireDirLock(path.resolve(dir));
    let lite: PGlite;
    try {
      lite = await PGlite.create(memory ? undefined : path.resolve(dir), {
        parsers: { [INT8]: asNumber, [NUMERIC]: asString },
      });
    } catch (err) {
      release();
      throw err;
    }
    const lock = new Mutex();
    const wrap = (q: Pick<PGlite, 'query' | 'exec'>): Executor => ({
      async query(sql, values) {
        const r = await q.query(sql, values);
        return { rows: r.rows, affected: r.affectedRows ?? 0 };
      },
      async exec(sql) {
        await q.exec(sql);
      },
    });
    const inner = wrap(lite);
    const base: Executor = {
      query: (sql, values) => lock.run(() => inner.query(sql, values)),
      exec: (sql) => lock.run(() => inner.exec(sql)),
    };
    return new Db(
      memory ? 'memory:' : dir,
      'pglite',
      base,
      (fn) => lock.run(() => lite.transaction((tx) => fn(wrap(tx)))),
      async () => {
        await lite.close();
        release();
      },
    );
  }

  private executor(): Executor {
    return this.current.getStore() ?? this.base;
  }

  private prepare(sql: string, params: Params): { text: string; values: unknown[] } {
    let c = this.compiled.get(sql);
    if (!c) {
      c = compile(sql);
      this.compiled.set(sql, c);
    }
    const values = c.order.map((key) => {
      if (typeof key === 'number') {
        if (!Array.isArray(params)) throw new Error(`positional parameter used with named params: ${sql}`);
        return toValue(params[key]);
      }
      if (Array.isArray(params) || !(key in params)) throw new Error(`missing SQL parameter :${key}`);
      return toValue(params[key]);
    });
    return { text: c.text, values };
  }

  async run(sql: string, params: Params = []): Promise<{ changes: number }> {
    const { text, values } = this.prepare(sql, params);
    return { changes: (await this.executor().query(text, values)).affected };
  }

  /** Runs an INSERT and returns the new row's id. */
  async insert(sql: string, params: Params = []): Promise<number> {
    const row = await this.get<{ id: number }>(`${sql} RETURNING id`, params);
    return row!.id;
  }

  async get<T>(sql: string, params: Params = []): Promise<T | undefined> {
    const { text, values } = this.prepare(sql, params);
    return (await this.executor().query(text, values)).rows[0] as T | undefined;
  }

  async all<T>(sql: string, params: Params = []): Promise<T[]> {
    const { text, values } = this.prepare(sql, params);
    return (await this.executor().query(text, values)).rows as T[];
  }

  /** Runs one or more statements without parameters (DDL, migrations). */
  async exec(sql: string): Promise<void> {
    await this.executor().exec(sql);
  }

  /** Runs `fn` atomically. Nested calls use savepoints, so inner failures roll back only their part. */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const active = this.current.getStore();
    if (active) {
      const sp = `sp_${++this.savepoints}`;
      await active.exec(`SAVEPOINT ${sp}`);
      try {
        const result = await fn();
        await active.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        await active.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        throw err;
      }
    }
    return this.transaction((executor) => this.current.run(executor, fn));
  }

  get inTransaction(): boolean {
    return this.current.getStore() !== undefined;
  }

  /** Size of the database in bytes (works on both engines). */
  async sizeBytes(): Promise<number> {
    return (await this.get<{ n: number }>('SELECT pg_database_size(current_database())::bigint AS n'))!.n;
  }

  async close(): Promise<void> {
    await this.closeEngine();
  }
}

/** True for a unique-constraint violation on either engine. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export const nowIso = () => new Date().toISOString();
export const bool = (v: boolean) => (v ? 1 : 0);
export const big = (v: string | null | undefined): bigint | null =>
  v === null || v === undefined ? null : BigInt(v);
export const bigStr = (v: bigint | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString();
