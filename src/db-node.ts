import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Db, Params } from './db.ts';

/**
 * SQLite über node:sqlite. Die Befehle laufen synchron; damit Transaktionen mit await-Schritten
 * nicht mit anderen Anfragen vermischt werden, gibt es eine Sperre: Solange eine Transaktion läuft,
 * warten alle Zugriffe von außerhalb.
 */
export class NodeDb implements Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private als = new AsyncLocalStorage<symbol>();
  private lock: Promise<void> | null = null;
  private owner: symbol | null = null;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
  }

  /** Wartet, falls gerade eine fremde Transaktion läuft. */
  private async ready() {
    while (this.lock && this.als.getStore() !== this.owner) await this.lock;
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private args(params?: Params): any[] {
    return params === undefined ? [] : Array.isArray(params) ? params : [params];
  }

  async get<T>(sql: string, params?: Params): Promise<T | undefined> {
    await this.ready();
    return this.stmt(sql).get(...this.args(params)) as T | undefined;
  }

  async all<T>(sql: string, params?: Params): Promise<T[]> {
    await this.ready();
    return this.stmt(sql).all(...this.args(params)) as T[];
  }

  async run(sql: string, params?: Params): Promise<number> {
    await this.ready();
    return Number(this.stmt(sql).run(...this.args(params)).changes);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.owner && this.als.getStore() === this.owner) return fn(); // verschachtelt
    await this.ready();
    const token = Symbol('tx');
    let release!: () => void;
    this.lock = new Promise((r) => (release = r));
    this.owner = token;
    try {
      return await this.als.run(token, async () => {
        this.raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn();
          this.raw.exec('COMMIT');
          return result;
        } catch (err) {
          this.raw.exec('ROLLBACK');
          throw err;
        }
      });
    } finally {
      this.owner = null;
      this.lock = null;
      release();
    }
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  close() {
    this.raw.close();
  }
}

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Wendet neue SQL-Dateien aus migrations/ an (gleiche Dateien nutzt `wrangler d1 migrations apply`). */
export async function migrate(db: NodeDb, dir = MIGRATIONS_DIR): Promise<string[]> {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((await db.all<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await db.tx(async () => {
      db.exec(sql);
      await db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [file, new Date().toISOString()]);
    });
    applied.push(file);
  }
  return applied;
}

export async function openNodeDb(path: string): Promise<NodeDb> {
  const db = new NodeDb(path);
  await migrate(db);
  return db;
}
