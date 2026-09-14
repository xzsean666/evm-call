import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { storageError } from "../domain/errors";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

export interface SqliteStorageOptions {
  /**
   * Database file path. Defaults to "./data/evm-call.db".
   * Note: Default is a persistent file, NOT in-memory. Can be explicitly set to ":memory:".
   */
  readonly path?: string;
  readonly busyTimeoutMs?: number;
}

export const DEFAULT_SQLITE_PATH = "./data/evm-call.db";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS evm_cooldown_states (
  endpoint_id TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL,
  current_cooldown_ms INTEGER NOT NULL,
  cooldown_until INTEGER,
  first_failure_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evm_rpc_cache (
  cache_key TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  is_historical INTEGER NOT NULL,
  block_tag TEXT,
  result_payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evm_rpc_cache_expires ON evm_rpc_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_evm_rpc_cache_chain_method ON evm_rpc_cache(chain_id, method);
`;

export class SqliteStorageAdapter {
  private readonly path: string;
  private readonly busyTimeoutMs: number;
  private db: DatabaseSyncType | null = null;
  private readonly statementCache = new Map<string, any>();
  private inTransaction = false;

  constructor(options: SqliteStorageOptions = {}) {
    this.path = options.path ?? DEFAULT_SQLITE_PATH;
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  }

  initialize(): void {
    if (this.db !== null) {
      return;
    }

    if (this.path !== ":memory:") {
      try {
        const fullPath = resolve(this.path);
        mkdirSync(dirname(fullPath), { recursive: true });
      } catch (error: unknown) {
        throw storageError(`Failed to create directory for SQLite database at ${this.path}`, error);
      }
    }

    try {
      const db = new DatabaseSync(this.path);
      db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(this.busyTimeoutMs))};`);
      if (this.path !== ":memory:") {
        try {
          db.exec("PRAGMA journal_mode = WAL;");
          db.exec("PRAGMA synchronous = NORMAL;");
        } catch {
          // Ignore if environment does not support WAL
        }
      }
      db.exec(SCHEMA_SQL);
      this.db = db;
    } catch (error: unknown) {
      this.db = null;
      throw storageError("Failed to initialize SQLite storage.", error);
    }
  }

  private ready(): DatabaseSyncType {
    if (this.db === null) {
      this.initialize();
    }
    return this.db!;
  }

  private getStatement(sql: string): any {
    let stmt = this.statementCache.get(sql);
    if (stmt === undefined) {
      stmt = this.ready().prepare(sql);
      if (this.statementCache.size >= 128) {
        const firstKey = this.statementCache.keys().next().value;
        if (firstKey !== undefined) {
          this.statementCache.delete(firstKey);
        }
      }
      this.statementCache.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): void {
    this.ready().exec(sql);
  }

  run(sql: string, params?: readonly unknown[]): { changes: number; lastInsertRowid?: bigint | number } {
    const statement = this.getStatement(sql);
    const result =
      params === undefined
        ? statement.run()
        : statement.run(...params.map(toSqliteParam));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined {
    const statement = this.getStatement(sql);
    return (
      params === undefined
        ? statement.get()
        : statement.get(...params.map(toSqliteParam))
    ) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[] {
    const statement = this.getStatement(sql);
    return (
      params === undefined
        ? statement.all()
        : statement.all(...params.map(toSqliteParam))
    ) as T[];
  }

  transaction<T>(fn: (adapter: SqliteStorageAdapter) => T): T {
    if (this.inTransaction) {
      return fn(this);
    }

    const db = this.ready();
    db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn(this);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    if (this.db !== null) {
      this.statementCache.clear();
      this.db.close();
      this.db = null;
    }
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  getPath(): string {
    return this.path;
  }
}

function toSqliteParam(val: unknown): string | number | bigint | null | Uint8Array {
  if (val === undefined || val === null) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (typeof val === "number" || typeof val === "bigint" || typeof val === "string" || val instanceof Uint8Array) {
    return val;
  }
  return String(val);
}

