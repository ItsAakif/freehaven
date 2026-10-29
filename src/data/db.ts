import * as SQLite from 'expo-sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

export type RunResult = { changes: number; lastInsertRowId: number };

/** Minimal async SQL surface so repositories stay driver-agnostic and testable. */
export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function expoDriver(db: SQLite.SQLiteDatabase): SqlDriver {
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => {
      const r = await db.runAsync(sql, params as SQLite.SQLiteBindValue[]);
      return { changes: r.changes, lastInsertRowId: r.lastInsertRowId };
    },
    all: <T,>(sql: string, params: unknown[] = []) =>
      db.getAllAsync<T>(sql, params as SQLite.SQLiteBindValue[]),
    first: <T,>(sql: string, params: unknown[] = []) =>
      db.getFirstAsync<T>(sql, params as SQLite.SQLiteBindValue[]),
    transaction: async (fn) => {
      await db.execAsync('BEGIN IMMEDIATE');
      try {
        const out = await fn();
        await db.execAsync('COMMIT');
        return out;
      } catch (error) {
        await db.execAsync('ROLLBACK');
        throw error;
      }
    },
    close: () => db.closeAsync(),
  };
}

let active: SqlDriver | null = null;
let opening: Promise<SqlDriver> | null = null;

export async function migrate(driver: SqlDriver): Promise<number> {
  const row = await driver.first<{ user_version: number }>('PRAGMA user_version');
  let current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database version ${current} is newer than this build (${SCHEMA_VERSION}). Update Freehaven to continue.`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await driver.transaction(async () => {
      await driver.exec(migration.sql);
      await driver.exec(`PRAGMA user_version = ${migration.version}`);
    });
    current = migration.version;
  }
  await driver.exec('PRAGMA foreign_keys = ON');
  return current;
}

export async function initDatabase(): Promise<SqlDriver> {
  if (active) return active;
  if (opening) return opening;
  opening = (async () => {
    const native = await SQLite.openDatabaseAsync('freehaven.db');
    const driver = expoDriver(native);
    // Journal mode cannot be changed inside a transaction, so set it before migrating.
    await driver.exec('PRAGMA journal_mode = WAL');
    await driver.exec('PRAGMA foreign_keys = ON');
    await migrate(driver);
    active = driver;
    return driver;
  })();
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

/** Access the initialised driver. Throws early if a screen forgot the provider. */
export function db(): SqlDriver {
  if (!active) throw new Error('Database is not initialised yet. Wrap the app in <DatabaseProvider>.');
  return active;
}

/** Test seam: inject a driver (better-sqlite3 in Jest) without opening Expo SQLite. */
export async function setDriverForTests(driver: SqlDriver): Promise<void> {
  await driver.exec('PRAGMA foreign_keys = ON');
  await migrate(driver);
  active = driver;
}

export async function resetDriverForTests(): Promise<void> {
  active = null;
}

export async function closeDatabase(): Promise<void> {
  if (active) await active.close();
  active = null;
}
