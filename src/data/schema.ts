/**
 * Schema v1.
 *
 * The database is the source of truth for the app: catalogue metadata, imported
 * documents, extracted text, reading state, generated learning artefacts,
 * conversations and FSRS scheduling all live here. Large binaries stay on the
 * filesystem and are referenced by path.
 */

export const SCHEMA_VERSION = 7;

export const MIGRATION_1 = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  subtitle       TEXT,
  author         TEXT,
  description    TEXT,
  cover_url      TEXT,
  language       TEXT,
  isbn13         TEXT,
  publisher      TEXT,
  published_year INTEGER,
  page_count     INTEGER,
  source         TEXT NOT NULL DEFAULT 'catalogue',
  source_id      TEXT,
  license        TEXT,
  access         TEXT NOT NULL DEFAULT 'metadata',
  external_url   TEXT,
  epub_url       TEXT,
  in_library     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_library ON books (in_library, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_author ON books (author);
CREATE INDEX IF NOT EXISTS idx_books_source ON books (source, source_id);

CREATE TABLE IF NOT EXISTS topics (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS book_topics (
  book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, topic_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format      TEXT NOT NULL,
  file_path   TEXT,
  file_size   INTEGER,
  page_count  INTEGER,
  word_count  INTEGER,
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  extractor   TEXT,
  imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_book ON documents (book_id);

CREATE TABLE IF NOT EXISTS sections (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  title       TEXT,
  href        TEXT,
  start_page  INTEGER,
  end_page    INTEGER,
  char_start  INTEGER,
  char_end    INTEGER,
  text        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sections_document ON sections (document_id, ordinal);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_id  TEXT REFERENCES sections(id) ON DELETE SET NULL,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  page        INTEGER,
  char_start  INTEGER,
  char_end    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks (document_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (
  chunk_id UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (chunk_id, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
  INSERT INTO chunks_fts (chunk_id, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS reading_positions (
  book_id       TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  locator       TEXT NOT NULL,
  percent       REAL NOT NULL DEFAULT 0,
  section_title TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  locator    TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks (book_id, created_at DESC);

CREATE TABLE IF NOT EXISTS highlights (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  locator    TEXT NOT NULL,
  quote      TEXT NOT NULL,
  note       TEXT,
  color      TEXT NOT NULL DEFAULT 'gold',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights (book_id, created_at DESC);

CREATE TABLE IF NOT EXISTS summaries (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body_md    TEXT NOT NULL,
  provider   TEXT NOT NULL,
  model      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_summaries_book ON summaries (book_id, kind);

CREATE TABLE IF NOT EXISTS summary_sources (
  summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  chunk_id   TEXT NOT NULL,
  PRIMARY KEY (summary_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS cards (
  id              TEXT PRIMARY KEY,
  book_id         TEXT REFERENCES books(id) ON DELETE CASCADE,
  front           TEXT NOT NULL,
  back            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'basic',
  options_json    TEXT,
  answer          TEXT,
  explanation     TEXT,
  source_chunk_id TEXT,
  state           TEXT NOT NULL DEFAULT 'new',
  stability       REAL NOT NULL DEFAULT 0,
  difficulty      REAL NOT NULL DEFAULT 0,
  reps            INTEGER NOT NULL DEFAULT 0,
  lapses          INTEGER NOT NULL DEFAULT 0,
  due_at          INTEGER NOT NULL,
  last_review_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_due ON cards (due_at);
CREATE INDEX IF NOT EXISTS idx_cards_book ON cards (book_id);

CREATE TABLE IF NOT EXISTS reviews (
  id             TEXT PRIMARY KEY,
  card_id        TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating         INTEGER NOT NULL,
  reviewed_at    INTEGER NOT NULL,
  elapsed_days   REAL,
  scheduled_days REAL,
  stability      REAL,
  difficulty     REAL
);

CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews (card_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  goal       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_items (
  id       TEXT PRIMARY KEY,
  plan_id  TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  status   TEXT NOT NULL DEFAULT 'todo'
);

CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items (plan_id, ordinal);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  book_id    TEXT REFERENCES books(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  citations_json  TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload_json TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, created_at);

CREATE TABLE IF NOT EXISTS downloads (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  path       TEXT,
  bytes      INTEGER,
  status     TEXT NOT NULL DEFAULT 'pending',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const MIGRATION_6 = `
-- Migration 6: generation job progress, checkpoints, stale-lease recovery.
-- Additive only. No table rebuild, no column drop, no data rewrite.

ALTER TABLE jobs ADD COLUMN rendition_id TEXT REFERENCES renditions(id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN stage TEXT;
ALTER TABLE jobs ADD COLUMN progress REAL NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN units_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN units_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN eta_remaining_ms INTEGER;
ALTER TABLE jobs ADD COLUMN eta_low_ms INTEGER;
ALTER TABLE jobs ADD COLUMN eta_high_ms INTEGER;
ALTER TABLE jobs ADD COLUMN started_at INTEGER;
ALTER TABLE jobs ADD COLUMN heartbeat_at INTEGER;
ALTER TABLE jobs ADD COLUMN finished_at INTEGER;
ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN script_hash TEXT;
ALTER TABLE jobs ADD COLUMN synth_hash TEXT;

-- Exactly one queued/running generation job per rendition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_rendition
  ON jobs (rendition_id)
  WHERE status IN ('queued', 'running') AND rendition_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_rendition
  ON jobs (rendition_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_type_status
  ON jobs (type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_heartbeat
  ON jobs (status, heartbeat_at);

CREATE TABLE IF NOT EXISTS job_units (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL,                 -- 'map' | 'merge' | 'reduce' | 'expand' | 'synth'
  ordinal      INTEGER NOT NULL,              -- position inside the stage plan
  status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'done' | 'failed'
  input_key    TEXT NOT NULL,                 -- hash(stage_key + stage + ordinal + unit input)
  payload_json TEXT,                          -- what the unit was asked to do (debug + replay)
  result_json  TEXT,                          -- checkpoint value; NULL until done
  attempts     INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- The resume key. Also the double-write guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_units_ordinal
  ON job_units (job_id, stage, ordinal);
-- The resume scan: done units for a stage, in plan order.
CREATE INDEX IF NOT EXISTS idx_job_units_resume
  ON job_units (job_id, stage, status, ordinal);
CREATE INDEX IF NOT EXISTS idx_job_units_status
  ON job_units (status, updated_at);
`;

export const MIGRATION_7 = `
-- Migration 7: exact word timings from engines that expose them.
-- Additive only. Existing segments keep NULL and fall back to estimated progress.

ALTER TABLE rendition_segments ADD COLUMN timings_json TEXT;
`;

export type Migration = { version: number; sql: string };

export const MIGRATION_2 = `
ALTER TABLE bookmarks ADD COLUMN folder_id TEXT;
ALTER TABLE bookmarks ADD COLUMN tags_json TEXT;
ALTER TABLE summaries ADD COLUMN section_id TEXT;
ALTER TABLE plan_items ADD COLUMN reason TEXT;

CREATE TABLE IF NOT EXISTS bookmark_folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profile (
  id                   TEXT PRIMARY KEY,
  goal                 TEXT,
  topics_json          TEXT,
  familiarity_json     TEXT,
  minutes_per_day      INTEGER NOT NULL DEFAULT 15,
  onboarding_complete  INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_events (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  book_id       TEXT,
  minutes       REAL NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_section ON summaries (book_id, section_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks (folder_id);
`;

export const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS audio_queue (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  title      TEXT,
  status     TEXT NOT NULL DEFAULT 'queued',
  file_path  TEXT,
  duration   REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audio_queue_book ON audio_queue (book_id, ordinal);
`;

export const MIGRATION_4 = `
ALTER TABLE user_profile ADD COLUMN display_name TEXT;
`;

export const MIGRATION_5 = `
-- One rendition per (work, language, style, length). Changing voice/engine rewrites the same row.
CREATE TABLE IF NOT EXISTS renditions (
  id              TEXT PRIMARY KEY,
  book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  language        TEXT NOT NULL,
  style_id        TEXT NOT NULL,
  length_preset   TEXT NOT NULL,              -- '5' | '15' | '25'
  engine          TEXT NOT NULL DEFAULT 'device', -- 'device' | 'remote' | 'piper' | 'kokoro'
  voice           TEXT,
  model           TEXT,
  instruction     TEXT,                       -- free-form user instruction, <= 280 chars
  instruction_hash TEXT,                      -- 8 hex chars; invalidates segments on change
  status          TEXT NOT NULL DEFAULT 'draft',
                  -- 'draft' | 'scripting' | 'script_ready' | 'synthesising' | 'ready' | 'failed'
  script_md       TEXT,
  script_provider TEXT,
  script_model    TEXT,
  word_count      INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (book_id, language, style_id, length_preset)
);

CREATE INDEX IF NOT EXISTS idx_renditions_book ON renditions (book_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_renditions_status ON renditions (status);

CREATE TABLE IF NOT EXISTS rendition_segments (
  id              TEXT PRIMARY KEY,
  rendition_id    TEXT NOT NULL REFERENCES renditions(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  section_id      TEXT,                       -- sections.id when known (no FK: sections are re-extracted)
  section_ordinal INTEGER,
  title           TEXT,                       -- section title, shown as a chapter marker
  text            TEXT NOT NULL,              -- exact text sent to the engine; replay + re-synthesis source
  speech_key      TEXT,                       -- cache key of the produced file (see narration.md)
  file_path       TEXT,
  format          TEXT,                       -- 'mp3' | 'wav'
  duration_ms     INTEGER,
  bytes           INTEGER,
  start_ms        INTEGER NOT NULL DEFAULT 0, -- offset within the logical asset
  status          TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'ready' | 'failed'
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rendition_segments_ordinal
  ON rendition_segments (rendition_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_rendition_segments_status
  ON rendition_segments (rendition_id, status);

CREATE TABLE IF NOT EXISTS rendition_progress (
  rendition_id TEXT PRIMARY KEY REFERENCES renditions(id) ON DELETE CASCADE,
  position_ms  INTEGER NOT NULL DEFAULT 0,
  percent      REAL NOT NULL DEFAULT 0,
  completed    INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

-- Locally installed TTS model bundles. One row per downloadable bundle, not per rendition.
CREATE TABLE IF NOT EXISTS narration_engines (
  id            TEXT PRIMARY KEY,             -- e.g. 'piper-en-lessac', 'kokoro-int8-multi'
  engine        TEXT NOT NULL,                -- 'piper' | 'kokoro'
  label         TEXT NOT NULL,
  bundle_url    TEXT,
  bundle_bytes  INTEGER,
  model_dir     TEXT,
  status        TEXT NOT NULL DEFAULT 'absent', -- 'absent'|'downloading'|'ready'|'failed'
  progress      REAL NOT NULL DEFAULT 0,
  verified_at   INTEGER,
  error         TEXT,
  updated_at    INTEGER NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
  { version: 3, sql: MIGRATION_3 },
  { version: 4, sql: MIGRATION_4 },
  { version: 5, sql: MIGRATION_5 },
  { version: 6, sql: MIGRATION_6 },
  { version: 7, sql: MIGRATION_7 },
];
