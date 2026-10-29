/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/data/db';
import { createTestDriver } from '@/data/__tests__/testDriver';

describe('schema and migrations', () => {
  it('creates the full schema and records the version', async () => {
    const driver = createTestDriver();
    const version = await migrate(driver);
    expect(version).toBe(3);
    const pragma = await driver.first<{ user_version: number }>('PRAGMA user_version');
    expect(pragma?.user_version).toBe(3);

    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    for (const expected of [
      'books',
      'documents',
      'sections',
      'chunks',
      'chunks_fts',
      'highlights',
      'summaries',
      'cards',
      'reviews',
      'conversations',
      'messages',
      'plans',
      'jobs',
      'audio_queue',
      'user_profile',
      'activity_events',
    ]) {
      expect(names).toContain(expected);
    }
    await driver.close();
  });

  it('is idempotent when run twice', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    const before = await driver.all<{ name: string }>('SELECT name FROM sqlite_master');
    await migrate(driver);
    const after = await driver.all<{ name: string }>('SELECT name FROM sqlite_master');
    expect(after.length).toBe(before.length);
    await driver.close();
  });

  it('keeps the FTS index in sync with chunk inserts and deletes', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      "INSERT INTO documents (id, book_id, format, status, imported_at) VALUES ('d','b','text','ready',0)",
    );
    await driver.run(
      "INSERT INTO chunks (id, document_id, ordinal, text) VALUES ('c1','d',0,'deliberate practice improves performance')",
    );
    const hit = await driver.first<{ chunk_id: string }>(
      "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH 'deliberate'",
    );
    expect(hit?.chunk_id).toBe('c1');
    await driver.run("DELETE FROM chunks WHERE id = 'c1'");
    const after = await driver.all("SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH 'deliberate'");
    expect(after).toHaveLength(0);
    await driver.close();
  });

  it('cascades document and chunk deletion from a book', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      "INSERT INTO documents (id, book_id, format, status, imported_at) VALUES ('d','b','text','ready',0)",
    );
    await driver.run("INSERT INTO chunks (id, document_id, ordinal, text) VALUES ('c','d',0,'hello world')");
    await driver.run("DELETE FROM books WHERE id = 'b'");
    expect(await driver.all('SELECT * FROM documents')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM chunks')).toHaveLength(0);
    await driver.close();
  });

  it('clears the FTS index when a book is deleted by cascade', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      "INSERT INTO documents (id, book_id, format, status, imported_at) VALUES ('d','b','text','ready',0)",
    );
    await driver.run(
      "INSERT INTO chunks (id, document_id, ordinal, text) VALUES ('c','d',0,'unmistakable phrase for cascade')",
    );
    await driver.run("DELETE FROM books WHERE id = 'b'");
    const rows = await driver.all("SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH 'unmistakable'");
    expect(rows).toHaveLength(0);
    await driver.close();
  });

  it('migrates a file-backed database with WAL enabled outside the transaction', async () => {
    const file = path.join(os.tmpdir(), `freehaven-test-${Date.now()}.db`);
    const driver = createTestDriver(file);
    try {
      await driver.exec('PRAGMA journal_mode = WAL');
      await migrate(driver);
      const journal = await driver.first<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(journal?.journal_mode).toBe('wal');
    } finally {
      await driver.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(`${file}${suffix}`);
        } catch {
          /* not present */
        }
      }
    }
  });
});

