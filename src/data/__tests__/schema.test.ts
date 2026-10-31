/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/data/db';
import { MIGRATION_1, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATIONS } from '@/data/schema';
import { createTestDriver } from '@/data/__tests__/testDriver';

describe('schema and migrations', () => {
  it('creates the full schema and records the version', async () => {
    const driver = createTestDriver();
    const version = await migrate(driver);
    expect(version).toBe(8);
    const pragma = await driver.first<{ user_version: number }>('PRAGMA user_version');
    expect(pragma?.user_version).toBe(8);

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
      'job_units',
      'audio_queue',
      'user_profile',
      'activity_events',
      'renditions',
      'rendition_segments',
      'rendition_progress',
      'narration_engines',
      'guides',
      'guide_chapters',
      'guide_chapter_segments',
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

  it('cascades renditions, segments and progress from a book', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      `INSERT INTO renditions (id, book_id, language, style_id, length_preset, created_at, updated_at)
       VALUES ('r','b','en','fireside','15',0,0)`,
    );
    await driver.run(
      `INSERT INTO rendition_segments (id, rendition_id, ordinal, text, created_at, updated_at)
       VALUES ('s','r',0,'hello',0,0)`,
    );
    await driver.run(
      "INSERT INTO rendition_progress (rendition_id, updated_at) VALUES ('r',0)",
    );
    await driver.run("DELETE FROM books WHERE id = 'b'");
    expect(await driver.all('SELECT * FROM renditions')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM rendition_segments')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM rendition_progress')).toHaveLength(0);
    await driver.close();
  });

  it('keeps audio_queue data across the v4 to v5 upgrade', async () => {
    const driver = createTestDriver();
    await driver.exec(MIGRATION_1);
    for (const migration of MIGRATIONS.filter((m) => m.version > 1 && m.version <= 4)) {
      await driver.exec(migration.sql);
    }
    await driver.exec('PRAGMA user_version = 4');
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      `INSERT INTO audio_queue (id, book_id, section_id, ordinal, status, file_path, created_at, updated_at)
       VALUES ('q','b','s1',0,'ready','/tmp/a.mp3',0,0)`,
    );

    expect(await migrate(driver)).toBe(8);
    const rows = await driver.all<{ id: string; file_path: string }>('SELECT * FROM audio_queue');
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe('/tmp/a.mp3');
    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['renditions', 'rendition_segments', 'rendition_progress', 'narration_engines']),
    );
    await driver.close();
  });

  it('keeps migration 5 additive', () => {
    expect(MIGRATION_5.toUpperCase()).not.toMatch(/\bDROP\b/);
    expect(MIGRATION_5.toUpperCase()).not.toMatch(/ALTER\s+TABLE\s+AUDIO_QUEUE/);
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

  it('upgrades a v1 database in place and preserves bookmarks', async () => {
    const driver = createTestDriver();
    await driver.exec(MIGRATION_1);
    await driver.exec('PRAGMA user_version = 1');
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Old Book','import','user_import',0,0)",
    );
    await driver.run(
      "INSERT INTO bookmarks (id, book_id, locator, label, created_at) VALUES ('bm1','b','{}','Old bookmark',1)",
    );
    await migrate(driver);
    const columns = await driver.all<{ name: string }>('PRAGMA table_info(bookmarks)');
    expect(columns.map((c) => c.name)).toContain('folder_id');
    const bookmarks = await driver.all<{ label: string }>('SELECT * FROM bookmarks');
    expect(bookmarks[0].label).toBe('Old bookmark');
    const profileColumns = await driver.all<{ name: string }>('PRAGMA table_info(user_profile)');
    expect(profileColumns.map((c) => c.name)).toContain('display_name');
    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['renditions', 'rendition_segments', 'rendition_progress', 'narration_engines']),
    );
    await driver.close();
  });

  it('rejects a database newer than the binary', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    await driver.exec('PRAGMA user_version = 99');
    await expect(migrate(driver)).rejects.toThrow(/newer/);
    await driver.close();
  });

  it('adds every generation column and the job_units table', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    expect(await driver.first<{ user_version: number }>('PRAGMA user_version')).toMatchObject({
      user_version: 8,
    });
    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    expect(tables.map((t) => t.name)).toContain('job_units');

    const columns = (await driver.all<{ name: string }>('PRAGMA table_info(jobs)')).map(
      (column) => column.name,
    );
    for (const expected of [
      'rendition_id',
      'stage',
      'progress',
      'units_done',
      'units_total',
      'eta_remaining_ms',
      'eta_low_ms',
      'eta_high_ms',
      'started_at',
      'heartbeat_at',
      'finished_at',
      'cancel_requested',
      'script_hash',
      'synth_hash',
    ]) {
      expect(columns).toContain(expected);
    }
    await driver.close();
  });

  it('preserves an existing jobs row across the v5 to v6 upgrade', async () => {
    const driver = createTestDriver();
    await driver.exec(MIGRATION_1);
    for (const migration of MIGRATIONS.filter((m) => m.version > 1 && m.version <= 5)) {
      await driver.exec(migration.sql);
    }
    await driver.exec('PRAGMA user_version = 5');
    await driver.run(
      `INSERT INTO jobs (id, type, payload_json, status, attempts, created_at, updated_at)
       VALUES ('legacy','import','{}','queued',0,1,2)`,
    );

    expect(await migrate(driver)).toBe(8);
    const row = await driver.first<{
      id: string;
      type: string;
      progress: number;
      units_total: number;
      cancel_requested: number;
    }>('SELECT * FROM jobs WHERE id = ?', ['legacy']);
    expect(row).toMatchObject({
      id: 'legacy',
      type: 'import',
      progress: 0,
      units_total: 0,
      cancel_requested: 0,
    });
    await driver.close();
  });

  async function seedRendition(driver: ReturnType<typeof createTestDriver>): Promise<void> {
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      `INSERT INTO renditions (id, book_id, language, style_id, length_preset, created_at, updated_at)
       VALUES ('r','b','en','fireside','15',0,0)`,
    );
  }

  it('allows only one active job per rendition, and any number with a null rendition', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    await seedRendition(driver);
    await driver.run(
      `INSERT INTO jobs (id, type, status, rendition_id, created_at, updated_at)
       VALUES ('j1','narration.generate','running','r',0,0)`,
    );
    await expect(
      driver.run(
        `INSERT INTO jobs (id, type, status, rendition_id, created_at, updated_at)
         VALUES ('j2','narration.generate','running','r',0,0)`,
      ),
    ).rejects.toThrow(/UNIQUE/);

    await driver.run(
      `INSERT INTO jobs (id, type, status, rendition_id, created_at, updated_at)
       VALUES ('j3','import','running',NULL,0,0)`,
    );
    await driver.run(
      `INSERT INTO jobs (id, type, status, rendition_id, created_at, updated_at)
       VALUES ('j4','import','running',NULL,0,0)`,
    );
    expect(await driver.all("SELECT id FROM jobs WHERE rendition_id IS NULL")).toHaveLength(2);
    await driver.close();
  });

  it('cascades jobs and job units when a rendition is deleted', async () => {
    const driver = createTestDriver();
    await migrate(driver);
    await seedRendition(driver);
    await driver.run(
      `INSERT INTO jobs (id, type, status, rendition_id, created_at, updated_at)
       VALUES ('j1','narration.generate','running','r',0,0)`,
    );
    await driver.run(
      `INSERT INTO job_units (id, job_id, stage, ordinal, input_key, created_at, updated_at)
       VALUES ('u1','j1','map',0,'key',0,0)`,
    );
    await driver.run("DELETE FROM renditions WHERE id = 'r'");
    expect(await driver.all('SELECT * FROM jobs')).toHaveLength(0);
    expect(await driver.all('SELECT * FROM job_units')).toHaveLength(0);
    expect(await driver.all('PRAGMA foreign_key_check')).toEqual([]);
    await driver.close();
  });

  it('keeps migration 6 additive', () => {
    // Comments mention "no column drop"; only the executable SQL is checked.
    const sql = MIGRATION_6.replace(/--[^\n]*/g, '').toUpperCase();
    expect(sql).not.toMatch(/\bDROP\b/);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+\w+\s+RENAME/);
  });

  it('creates a fresh v8 database with timings_json on rendition_segments', async () => {
    const driver = createTestDriver();
    expect(await migrate(driver)).toBe(8);
    const columns = (
      await driver.all<{ name: string }>('PRAGMA table_info(rendition_segments)')
    ).map((column) => column.name);
    expect(columns).toContain('timings_json');
    await driver.close();
  });

  it('upgrades a v6 segment to v8 in place and preserves old data', async () => {
    const driver = createTestDriver();
    await driver.exec(MIGRATION_1);
    for (const migration of MIGRATIONS.filter(
      (candidate) => candidate.version > 1 && candidate.version <= 6,
    )) {
      await driver.exec(migration.sql);
    }
    await driver.exec('PRAGMA user_version = 6');
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      `INSERT INTO renditions (id, book_id, language, style_id, length_preset, created_at, updated_at)
       VALUES ('r','b','en','fireside','15',0,0)`,
    );
    await driver.run(
      `INSERT INTO rendition_segments
         (id, rendition_id, ordinal, text, file_path, duration_ms, created_at, updated_at)
       VALUES ('s','r',0,'hello','/audio/0.wav',1234,0,0)`,
    );

    expect(await migrate(driver)).toBe(8);
    const row = await driver.first<{
      text: string;
      file_path: string;
      duration_ms: number;
      timings_json: string | null;
    }>('SELECT * FROM rendition_segments WHERE id = ?', ['s']);
    expect(row).toMatchObject({
      text: 'hello',
      file_path: '/audio/0.wav',
      duration_ms: 1234,
      timings_json: null,
    });
    await driver.close();
  });

  it('keeps migration 7 additive', () => {
    const sql = MIGRATION_7.replace(/--[^\n]*/g, '').toUpperCase();
    expect(sql).not.toMatch(/\bDROP\b/);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+\w+\s+RENAME/);
  });

  it('keeps migration 8 additive and creates the guide schema', async () => {
    const sql = MIGRATION_8.replace(/--[^\n]*/g, '').toUpperCase();
    expect(sql).not.toMatch(/\bDROP\b/);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+\w+\s+RENAME/);
    expect(sql).not.toMatch(/\bREBUILD\b/);

    const driver = createTestDriver();
    expect(await migrate(driver)).toBe(8);
    const tables = (await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )).map((table) => table.name);
    for (const expected of ['guides', 'guide_chapters', 'guide_chapter_segments']) {
      expect(tables).toContain(expected);
    }

    const planColumns = (await driver.all<{ name: string }>('PRAGMA table_info(plan_items)')).map(
      (column) => column.name,
    );
    expect(planColumns).toContain('guide_chapter_id');

    const indexes = (await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    )).map((index) => index.name);
    for (const expected of [
      'idx_guides_book',
      'idx_guides_status',
      'idx_guides_plan',
      'idx_guide_chapters_guide',
      'idx_guide_chapters_status',
      'idx_guide_chapters_completed',
      'idx_guide_chapter_segments_ordinal',
      'idx_guide_chapter_segments_status',
      'idx_plan_items_guide_chapter',
    ]) {
      expect(indexes).toContain(expected);
    }
    await driver.close();
  });

  it('upgrades a v7 database with book, plan, plan item and rendition rows to v8', async () => {
    const driver = createTestDriver();
    await driver.exec(MIGRATION_1);
    for (const migration of MIGRATIONS.filter(
      (candidate) => candidate.version > 1 && candidate.version <= 7,
    )) {
      await driver.exec(migration.sql);
    }
    await driver.exec('PRAGMA user_version = 7');
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      "INSERT INTO plans (id, title, goal, created_at) VALUES ('p','Plan','goal',0)",
    );
    await driver.run(
      "INSERT INTO plan_items (id, plan_id, book_id, ordinal, status) VALUES ('i','p','b',0,'todo')",
    );
    await driver.run(
      `INSERT INTO renditions (id, book_id, language, style_id, length_preset, created_at, updated_at)
       VALUES ('r','b','en','fireside','15',0,0)`,
    );

    expect(await migrate(driver)).toBe(8);
    expect(await driver.all<{ id: string }>('SELECT id FROM books')).toHaveLength(1);
    expect(await driver.all<{ id: string }>('SELECT id FROM plans')).toHaveLength(1);
    const item = await driver.first<{ id: string; guide_chapter_id: string | null }>(
      'SELECT id, guide_chapter_id FROM plan_items WHERE id = ?',
      ['i'],
    );
    expect(item).toMatchObject({ id: 'i', guide_chapter_id: null });
    expect(await driver.all<{ id: string }>('SELECT id FROM renditions')).toHaveLength(1);
    await driver.close();
  });
});
