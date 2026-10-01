import { toOrdered, type Db, type Param, type Params } from './db.ts';

// Minimal benötigte D1-Typen (vermeidet eine zusätzliche Typ-Abhängigkeit).
interface D1Result<T> {
  results: T[];
  meta: { changes?: number };
}
interface D1PreparedStatement {
  bind(...values: Param[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

/** Cloudflare D1. Siehe Hinweis zu tx() in src/db.ts. */
export class D1Db implements Db {
  private d1: D1Database;
  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  private stmt(sql: string, params?: Params) {
    if (params === undefined) return this.d1.prepare(sql);
    if (Array.isArray(params)) return this.d1.prepare(sql).bind(...params);
    const o = toOrdered(sql, params);
    return this.d1.prepare(o.sql).bind(...o.values);
  }

  async get<T>(sql: string, params?: Params): Promise<T | undefined> {
    return ((await this.stmt(sql, params).first<T>()) ?? undefined) as T | undefined;
  }

  async all<T>(sql: string, params?: Params): Promise<T[]> {
    return (await this.stmt(sql, params).all<T>()).results;
  }

  async run(sql: string, params?: Params): Promise<number> {
    return (await this.stmt(sql, params).run()).meta.changes ?? 0;
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
