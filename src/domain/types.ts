export type Id = string;

export type BookSource = 'catalogue' | 'gutenberg' | 'import' | 'manual';
export type BookAccess = 'public_domain' | 'user_import' | 'external' | 'preview' | 'metadata';
export type DocumentFormat = 'epub' | 'pdf' | 'text';
export type DocumentStatus = 'pending' | 'extracting' | 'ready' | 'failed';
export type SummaryKind = 'summary' | 'chapter' | 'takeaways' | 'lesson' | 'concepts';
export type CardKind = 'basic' | 'mcq';
export type CardState = 'new' | 'learning' | 'review' | 'relearning';
export type Grade = 1 | 2 | 3 | 4;

export interface Book {
  id: Id;
  title: string;
  subtitle?: string | null;
  author?: string | null;
  description?: string | null;
  coverUrl?: string | null;
  language?: string | null;
  isbn13?: string | null;
  publisher?: string | null;
  publishedYear?: number | null;
  pageCount?: number | null;
  source: BookSource;
  sourceId?: string | null;
  license?: string | null;
  access: BookAccess;
  externalUrl?: string | null;
  epubUrl?: string | null;
  inLibrary: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Document {
  id: Id;
  bookId: Id;
  format: DocumentFormat;
  filePath?: string | null;
  fileSize?: number | null;
  pageCount?: number | null;
  wordCount?: number | null;
  status: DocumentStatus;
  error?: string | null;
  extractor?: string | null;
  importedAt: number;
}

export interface Section {
  id: Id;
  documentId: Id;
  ordinal: number;
  title?: string | null;
  href?: string | null;
  startPage?: number | null;
  endPage?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
  text?: string | null;
}

export interface Chunk {
  id: Id;
  documentId: Id;
  sectionId?: Id | null;
  ordinal: number;
  text: string;
  page?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
}

export interface Highlight {
  id: Id;
  bookId: Id;
  locator: string;
  quote: string;
  note?: string | null;
  color: string;
  createdAt: number;
}

export interface Bookmark {
  id: Id;
  bookId: Id;
  locator: string;
  label?: string | null;
  folderId?: Id | null;
  tags?: string[] | null;
  createdAt: number;
}

export interface ReadingPosition {
  bookId: Id;
  locator: string;
  percent: number;
  sectionTitle?: string | null;
  updatedAt: number;
}

export interface Summary {
  id: Id;
  bookId: Id;
  kind: SummaryKind;
  title: string;
  bodyMd: string;
  provider: string;
  model?: string | null;
  sectionId?: Id | null;
  createdAt: number;
  updatedAt: number;
}

export interface Citation {
  chunkId: Id;
  bookId: Id;
  page?: number | null;
  sectionTitle?: string | null;
  quote: string;
}

export interface Card {
  id: Id;
  bookId?: Id | null;
  front: string;
  back: string;
  kind: CardKind;
  options?: string[] | null;
  answer?: string | null;
  explanation?: string | null;
  sourceChunkId?: Id | null;
  state: CardState;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  dueAt: number;
  lastReviewAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Review {
  id: Id;
  cardId: Id;
  rating: Grade;
  reviewedAt: number;
  elapsedDays: number;
  scheduledDays: number;
  stability: number;
  difficulty: number;
}

export interface Conversation {
  id: Id;
  bookId?: Id | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: Id;
  conversationId: Id;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: Citation[] | null;
  createdAt: number;
}

export interface Plan {
  id: Id;
  title: string;
  goal?: string | null;
  createdAt: number;
}

export interface PlanItem {
  id: Id;
  planId: Id;
  bookId: Id;
  ordinal: number;
  status: 'todo' | 'doing' | 'done';
  reason?: string | null;
}

export interface Job {
  id: Id;
  type: string;
  payload?: Record<string, unknown> | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
