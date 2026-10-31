/**
 * Narration id unions shared by the AI, audio and data layers.
 *
 * Types only: no Expo or React Native imports, so Jest can import this module
 * directly and any repository may depend on it.
 */

import type { Book } from './types';

export type NarrationStyleId =
  | 'brief'
  | 'chronicle'
  | 'plain'
  | 'mechanism'
  | 'debate'
  | 'backstage'
  | 'fireside';

export type NarrationLength = '5' | '15' | '25';

export type RenditionEngine = 'device' | 'remote' | 'piper' | 'kokoro';

export type RenditionStatus =
  | 'draft'
  | 'scripting'
  | 'script_ready'
  | 'synthesising'
  | 'ready'
  | 'failed';

export type SegmentStatus = 'queued' | 'ready' | 'failed';

/** Word-level timing inside one synthesized segment. Offsets are milliseconds. */
export type SpeechTiming = {
  text: string;
  startMs: number;
  endMs: number;
};

export interface Rendition {
  id: string;
  bookId: string;
  language: string;
  styleId: string; // NarrationStyleId; unknown stored values coerce at read time
  length: NarrationLength;
  engine: RenditionEngine;
  voice: string | null;
  model: string | null;
  instruction: string | null;
  instructionHash: string | null;
  status: RenditionStatus;
  scriptMd: string | null;
  scriptProvider: string | null;
  scriptModel: string | null;
  wordCount: number;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RenditionSegment {
  id: string;
  renditionId: string;
  ordinal: number;
  sectionId: string | null;
  sectionOrdinal: number | null;
  title: string | null;
  text: string;
  speechKey: string | null;
  filePath: string | null;
  format: 'mp3' | 'wav' | null;
  durationMs: number | null;
  bytes: number | null;
  startMs: number;
  /** JSON array of SpeechTiming when the engine reported word timings; null otherwise. */
  timingsJson: string | null;
  status: SegmentStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RenditionProgress {
  renditionId: string;
  positionMs: number;
  percent: number;
  completed: boolean;
  updatedAt: number;
}

export type LibraryShelf = 'in_progress' | 'completed' | 'downloaded';

export interface LibraryEntry {
  book: Book;
  rendition: Rendition | null;
  positionMs: number;
  percent: number;
  completed: boolean;
  downloaded: boolean;
  updatedAt: number;
}

export interface QueuedSegment {
  sectionId: string | null;
  sectionOrdinal: number | null;
  title: string | null;
  text: string;
  speechKey: string;
  /** Optional precomputed word timings (JSON). Preserved when supplied. */
  timingsJson?: string | null;
}
