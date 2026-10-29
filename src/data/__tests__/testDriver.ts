/** better-sqlite3 adapter for repository tests (Node environment only). */
import Database from 'better-sqlite3';
import type { SqlDriver } from '@/data/db';

export function createTestDriver(filename = ':memory:'): SqlDriver & { raw: Database.Database } {
  const raw = new Database(filename);
  raw.pragma('foreign_keys = ON');
  return {
    raw,
    async exec(sql: string) {
      raw.exec(sql);
    },
    async run(sql: string, params: unknown[] = []) {
      const result = raw.prepare(sql).run(...(params as never[]));
      return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
    async first<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const row = raw.prepare(sql).get(...(params as never[]));
      return (row ?? null) as T | null;
    },
    async transaction<T>(fn: () => Promise<T>) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      raw.close();
    },
  };
}
