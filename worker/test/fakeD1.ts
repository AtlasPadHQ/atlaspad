/**
 * A D1Database stand-in over node:sqlite for unit tests, with the real migrations applied. Mirrors the D1 API surface
 * the Worker uses (prepare/bind/first/all/run/raw, batch as one transaction, exec) and D1's binding rules (no
 * undefined, no booleans, no bigint), so bugs that D1 would reject fail here too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function checkValue(v: unknown): unknown {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: Type undefined is not supported');
  if (typeof v === 'boolean') throw new Error('D1_TYPE_ERROR: booleans must be bound as 0/1 in this codebase');
  if (typeof v === 'bigint') throw new Error('D1_TYPE_ERROR: bigint is not supported');
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('D1_TYPE_ERROR: non-finite number');
  return v;
}

/** node:sqlite wants named-number params as an array; D1 uses ?N placeholders. */
function convertSql(sql: string): string {
  return sql;
}

class Stmt {
  constructor(
    private readonly db: FakeD1,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...values: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, values.map(checkValue));
  }
  private exec(): { rows: Record<string, unknown>[]; changes: number; lastRowId: number } {
    this.db.queries++;
    if (!this.db.inBatch) this.db.calls++;
    const st = this.db.raw.prepare(convertSql(this.sql));
    // a CTE that ends in a write (`WITH a AS (…) UPDATE …`) is a write, not a read
    const cteWrite = /^\s*WITH\b/i.test(this.sql) && /\)\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(this.sql);
    const isRead = (/^\s*(SELECT|WITH)\b/i.test(this.sql) && !cteWrite) || /\bRETURNING\b/i.test(this.sql);
    if (isRead) {
      const rows = st.all(...(this.params as never[])).map((r) => ({ ...r }));
      // a write with RETURNING reports its rows as changes (as D1 does)
      const changes = /\bRETURNING\b/i.test(this.sql) && (cteWrite || !/^\s*(SELECT|WITH)\b/i.test(this.sql)) ? rows.length : 0;
      this.db.wrote(this.sql, changes);
      return { rows, changes, lastRowId: 0 };
    }
    const r = st.run(...(this.params as never[]));
    this.db.wrote(this.sql, Number(r.changes));
    return { rows: [], changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const { rows } = this.exec();
    const r = rows[0];
    if (!r) return null;
    return (col ? (r[col] as T) : (r as T)) ?? null;
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const r = this.exec();
    return { results: r.rows as T[], success: true, meta: { changes: r.changes, last_row_id: r.lastRowId } } as unknown as D1Result<T>;
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }
  async raw<T = unknown[]>(): Promise<T[]> {
    const { rows } = this.exec();
    return rows.map((r) => Object.values(r)) as T[];
  }
  runSync(): { rows: Record<string, unknown>[]; changes: number; lastRowId: number } {
    return this.exec();
  }
}

export class FakeD1 {
  readonly raw: DatabaseSync;
  /** Statements run, each statement of a batch included. */
  queries = 0;
  /** D1 queries as Workers Free counts them against its 50 per invocation: a batch is one. */
  calls = 0;
  inBatch = false;
  /** Statements that changed rows, and how many (D1 bills rows written; index entries come on top): budget tests. */
  writeLog: { sql: string; changes: number }[] = [];
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    // every migration, in order (as `wrangler d1 migrations apply` does)
    const dir = new URL('../../migrations/', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) this.raw.exec(readFileSync(dir + f, 'utf8'));
  }
  prepare(sql: string): Stmt {
    return new Stmt(this, sql);
  }
  wrote(sql: string, changes: number): void {
    if (changes > 0) this.writeLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), changes });
  }
  async batch<T = unknown>(stmts: Stmt[]): Promise<D1Result<T>[]> {
    this.calls++;
    this.inBatch = true;
    this.raw.exec('BEGIN');
    try {
      const out = stmts.map((s) => {
        const r = s.runSync();
        return { results: r.rows, success: true, meta: { changes: r.changes, last_row_id: r.lastRowId } } as unknown as D1Result<T>;
      });
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.inBatch = false;
    }
  }
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.raw.exec(sql);
    return { count: 1, duration: 0 };
  }
  /** Synchronous helpers for assertions. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
