/**
 * One normaliser for every model payload shape.
 *
 * This is the only module that knows about model-specific key names. It never
 * throws: empty or unusable output comes back as `{ text: '', shape: 'empty' }`
 * and the provider decides whether that is an error.
 */

import type { Citation } from '@/domain/types';
import { detectTruncation } from './planner';
import type { ResponseStrategy } from './presets';
import type { AiTask } from './types';

export interface NormalisedModelOutput {
  /** '' when nothing usable. */
  text: string;
  citations: Citation[];
  truncated: boolean;
  shape: 'json_object' | 'json_array' | 'fenced_json' | 'prose' | 'empty';
}

const TEXT_ALIASES = [
  'answer',
  'summary',
  'text',
  'content',
  'output',
  'result',
  'response',
  'script',
  'takeaways',
  'notes',
] as const;

const ARRAY_ITEM_TEXT_KEYS = ['text', 'content', 'note', 'point'] as const;
const WRAPPER_TEXT_KEYS = ['parts', 'sections', 'paragraphs'] as const;

const CITATION_ALIASES = ['citations', 'sources', 'quotes', 'references', 'evidence'] as const;
const CHUNK_ID_KEYS = ['chunkId', 'chunk_id', 'id', 'sourceId', 'source_id'] as const;
const QUOTE_KEYS = ['quote', 'text', 'excerpt', 'snippet', 'span'] as const;

const MAX_TEXT = 40_000;
const MAX_QUOTE = 320;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/^\s*answer\s*:\s*/i, '')
    .trim();
}

function capText(value: string): string {
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

function stringPart(value: unknown): string {
  if (typeof value === 'string') return cleanString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function objectText(item: JsonObject): string {
  for (const key of ARRAY_ITEM_TEXT_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return cleanString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  for (const key of TEXT_ALIASES) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return cleanString(value);
  }
  return '';
}

function textFromValue(value: unknown): string {
  if (typeof value === 'string') return cleanString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) {
      return value
        .map((item) => cleanString(item as string))
        .filter(Boolean)
        .join('\n\n');
    }
    return value
      .map((item) => (isObject(item) ? objectText(item) : stringPart(item)))
      .filter(Boolean)
      .join('\n');
  }

  if (isObject(value)) {
    for (const key of WRAPPER_TEXT_KEYS) {
      const parts = value[key];
      if (!Array.isArray(parts)) continue;
      const joined = parts
        .map((part) => (isObject(part) ? objectText(part) : stringPart(part)))
        .filter(Boolean)
        .join('\n\n');
      if (joined) return joined;
    }
  }

  return '';
}

function textFromObject(object: JsonObject): string {
  for (const alias of TEXT_ALIASES) {
    if (!(alias in object)) continue;
    const text = textFromValue(object[alias]);
    if (text) return text;
  }
  return '';
}

function textFromArray(items: unknown[], task: AiTask | undefined): string {
  if (items.every((item) => typeof item === 'string')) {
    const strings = items.map((item) => cleanString(item as string)).filter(Boolean);
    if (!strings.length) return '';
    if (task === 'takeaways') return strings.map((item) => `- ${item}`).join('\n');
    return strings.join('\n\n');
  }
  return items
    .map((item) => (isObject(item) ? objectText(item) : stringPart(item)))
    .filter(Boolean)
    .join('\n');
}

function parseBareCitation(value: string): Citation | null {
  const text = value.trim();
  if (!text) return null;
  const chunkOnly = text.match(/^chunk_?id\s*:\s*(.+)$/i);
  if (chunkOnly) return { chunkId: chunkOnly[1].trim(), bookId: '', quote: '' };
  const pair = text.match(/^(.+?)\s+[—–-]\s+(.+)$/);
  if (pair) return { chunkId: pair[1].trim(), bookId: '', quote: pair[2].trim() };
  return null;
}

function citationFromItem(item: unknown): Citation | null {
  if (typeof item === 'string') return parseBareCitation(item);
  if (!isObject(item)) return null;

  let chunkId = '';
  for (const key of CHUNK_ID_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      chunkId = value.trim();
      break;
    }
  }
  if (!chunkId) return null;

  let quote = '';
  for (const key of QUOTE_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      quote = value.trim();
      break;
    }
  }
  if (quote.length > MAX_QUOTE) quote = quote.slice(0, MAX_QUOTE);
  return { chunkId, bookId: '', quote };
}

function citationsFromObject(object: JsonObject): Citation[] {
  for (const alias of CITATION_ALIASES) {
    if (!(alias in object)) continue;
    const value = object[alias];
    const items = Array.isArray(value) ? value : [value];
    return items
      .map(citationFromItem)
      .filter((citation): citation is Citation => citation !== null);
  }
  return [];
}

/** First balanced `{…}` / `[…]` block, quote- and escape-aware. */
function extractJsonBlock(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== '{' && first !== '[') continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') {
        const expected = stack.pop();
        if (!expected || expected !== ch) break;
        if (!stack.length) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function stripFence(raw: string): string {
  const text = raw.trim();
  const fenced = text.match(/^```(?:[a-z0-9_-]+)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

export function normaliseModelPayload(
  raw: string,
  opts: { strategy: ResponseStrategy; finishReason?: string; task?: AiTask },
): NormalisedModelOutput {
  const truncated = detectTruncation(opts.finishReason, raw);
  const empty: NormalisedModelOutput = {
    text: '',
    citations: [],
    truncated,
    shape: 'empty',
  };

  try {
    if (typeof raw !== 'string') return empty;
    const text = stripFence(raw);
    if (!text) return empty;

    let shape: NormalisedModelOutput['shape'] = 'prose';
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
      shape = Array.isArray(parsed) ? 'json_array' : isObject(parsed) ? 'json_object' : 'prose';
    } catch {
      const block = extractJsonBlock(text);
      if (block) {
        try {
          parsed = JSON.parse(block);
          shape = 'fenced_json';
        } catch {
          parsed = undefined;
        }
      }
    }

    if (parsed === undefined) {
      const prose = capText(cleanString(text));
      return prose
        ? { text: prose, citations: [], truncated, shape: 'prose' }
        : { ...empty, shape: 'empty' };
    }

    if (Array.isArray(parsed)) {
      const joined = capText(textFromArray(parsed, opts.task));
      if (!joined) return { ...empty, shape: 'empty' };
      return { text: joined, citations: [], truncated, shape };
    }

    if (!isObject(parsed)) return { ...empty, shape: 'empty' };

    const joined = capText(textFromObject(parsed));
    const citations = citationsFromObject(parsed);
    if (!joined && !citations.length) return { ...empty, shape: 'empty' };
    return { text: joined, citations, truncated, shape };
  } catch {
    return empty;
  }
}
