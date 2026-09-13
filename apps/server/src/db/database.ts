/**
 * Thin wrapper over node:sqlite (built into Node >= 22.13). SQLite in WAL mode is the single source of truth:
 * one process owns the write path, reads are cheap, and every multi-row change runs in a transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const res = Array.isArray(params) ? this.stmt(sql).run(...params) : this.stmt(sql).run(params);
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const row = Array.isArray(params) ? this.stmt(sql).get(...params) : this.stmt(sql).get(params);
    return row as T | undefined;
  }

  all<T>(sql: string, params: Params = []): T[] {
    const rows = Array.isArray(params) ? this.stmt(sql).all(...params) : this.stmt(sql).all(params);
    return rows as T[];
  }

  *iterate<T>(sql: string, params: Params = []): Generator<T> {
    const it = Array.isArray(params) ? this.stmt(sql).iterate(...params) : this.stmt(sql).iterate(params);
    for (const row of it) yield row as T;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs `fn` atomically. Nested calls use savepoints, so inner failures roll back only their part. */
  tx<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  close(): void {
    this.statements.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

export const nowIso = () => new Date().toISOString();
export const bool = (v: boolean) => (v ? 1 : 0);
export const big = (v: string | null | undefined): bigint | null =>
  v === null || v === undefined ? null : BigInt(v);
export const bigStr = (v: bigint | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString();
