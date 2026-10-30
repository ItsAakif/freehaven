/**
 * Project Gutenberg conformance harness.
 *
 * Node only — never imports Jest, Expo or SQLite. Network is used solely when
 * the script is invoked. Compile with `tsc -p scripts/tsconfig.harness.json`
 * and run `.harness/scripts/gutenberg-conformance.js`.
 *
 * Usage:
 *   node .harness/scripts/gutenberg-conformance.js [--sample 12] [--all]
 *        [--json out.json] [--only 2600,135]
 */

import { writeFileSync } from 'node:fs';
import { decodeBytes } from '../src/features/imports/charset';
import { EpubError, parseEpub } from '../src/features/imports/epub';
import {
  stripBoilerplateFromRawHtml,
  stripGutenbergBoilerplate,
} from '../src/features/imports/gutenberg';
import { htmlToText } from '../src/features/imports/html';
import {
  sourcesFromFormats,
  synthesiseGutenbergSources,
} from '../src/features/imports/gutenbergSources';
import { assessTextQuality } from '../src/features/imports/quality';
import type { ImportQuality } from '../src/features/imports/quality';
import { sniffBytes } from '../src/features/imports/sniff';
import type { SniffedFormat } from '../src/features/imports/sniff';
import {
  assertFullCoverage,
  planTiers,
  planWindowsH,
} from '../src/features/learning/windows';
import { planSpeechSegments } from '../src/features/narration/segments';
import {
  chunkText,
  extractiveSummary,
  normalizeWhitespace,
  wordCount,
} from '../src/domain/text';

process.env.HARNESS_STRICT = '1';

type Stratum = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

type Case = {
  id: string;
  title: string;
  languages: string;
  stratum: Stratum;
  sources: string[];
  expectedVerdict?: ImportQuality;
  informational?: boolean;
  fixture?: () => Uint8Array | Promise<Uint8Array>;
  note?: string;
};

type CaseResult = {
  id: string;
  title: string;
  languages: string;
  stratum: Stratum;
  format: SniffedFormat | '-';
  bytes: number;
  chars: number;
  words: number;
  wordsPer1k: number;
  printable: number;
  script: string;
  markers: boolean;
  verdict: ImportQuality | 'skipped';
  chunks: number;
  segs: number;
  maxSeg: number;
  coverage: number;
  parseMs: number;
  planMs: number;
  pass: boolean;
  reasons: string[];
  required: boolean;
  informational: boolean;
};

const MAX_EPUB_BYTES = 80 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

function now(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from([...text].map((ch) => (ch.charCodeAt(0) <= 0xff ? ch.charCodeAt(0) : 0x3f)));
}

function emptyBytes(): Uint8Array {
  return new Uint8Array();
}

function pngBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

function garbageBytes(): Uint8Array {
  const out = new Uint8Array(1024);
  for (let i = 0; i < out.length; i += 1) out[i] = i % 100 === 0 ? 0x78 : (i * 7) % 0x20;
  return out;
}

function missingMarkersText(): string {
  const body =
    'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.';
  return `Produced by Someone\n\n${body}\n\n${body}\n\nThe text ends without any licence markers.`;
}

function latin1Excerpt(): Uint8Array {
  const body = 'The café was small and quiet, and the naïve reader paused at the window. '.repeat(60);
  return latin1Bytes(
    `*** START OF THE PROJECT GUTENBERG EBOOK CAFE ***\n\n${body}\n\n*** END OF THE PROJECT GUTENBERG EBOOK CAFE ***`,
  );
}

function largeProse(chars = 600_000): string {
  const vocabulary = [
    'attention', 'memory', 'practice', 'reading', 'language', 'thought', 'habit', 'story',
    'question', 'answer', 'reason', 'evidence', 'chapter', 'reader', 'writer', 'history',
    'science', 'music', 'garden', 'morning', 'evening', 'distance', 'silence', 'signal',
  ];
  let state = 1;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const sentences: string[] = [];
  let length = 0;
  while (length < chars) {
    const count = 8 + Math.floor(rand() * 8);
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) parts.push(vocabulary[Math.floor(rand() * vocabulary.length)]);
    const joined = parts.join(' ');
    const sentence = `${joined[0].toUpperCase()}${joined.slice(1)}.`;
    sentences.push(sentence);
    length += sentence.length + 1;
    if (sentences.length % 7 === 0) {
      sentences.push('\n\n');
      length += 2;
    }
  }
  return sentences.join(' ');
}

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Freehaven-Conformance/1.0 (open-source learning app)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, 30_000);
      if (!response.ok) throw new Error(`http_${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('network');
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`http_${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_EPUB_BYTES) throw new Error('too_large');
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_EPUB_BYTES) throw new Error('too_large');
      return new Uint8Array(buffer);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('network');
}

type GutendexBook = {
  id: number;
  title: string;
  languages?: string[];
  formats?: Record<string, string>;
  media_type?: string;
};

type GutendexPage = {
  results?: GutendexBook[];
};

function rowToCase(book: GutendexBook, stratum: Stratum): Case {
  return {
    id: String(book.id),
    title: book.title,
    languages: (book.languages ?? []).join(','),
    stratum,
    sources: sourcesFromFormats(book.formats).map((source) => source.url),
  };
}

function seededPickTwo(ids: number[]): number[] {
  let state = 0x5f3759df;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const copy = [...ids];
  const out: number[] = [];
  while (copy.length && out.length < 2) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}

async function selectStrata(): Promise<{ cases: Case[]; errors: string[] }> {
  const cases: Case[] = [];
  const errors: string[] = [];

  try {
    const page = await fetchJson<GutendexPage>('https://gutendex.com/books?sort=popular&page=1');
    const textBooks = (page.results ?? []).filter((book) => book.media_type === 'Text');
    for (const book of textBooks.slice(0, 3)) cases.push(rowToCase(book, 'S1'));
  } catch (error) {
    errors.push(`S1: ${(error as Error).message}`);
  }

  const longIds = [2600, 135, 28054, 2554, 4300];
  for (const id of [...seededPickTwo(longIds), 1661]) {
    cases.push({ id: String(id), title: `Gutenberg #${id}`, languages: '', stratum: 'S2', sources: synthesiseGutenbergSources(String(id)).map((source) => source.url) });
  }

  for (const language of ['fr', 'de', 'es', 'ru', 'zh']) {
    try {
      const page = await fetchJson<GutendexPage>(
        `https://gutendex.com/books?languages=${language}&sort=popular`,
      );
      const book = (page.results ?? [])[0];
      if (book) cases.push(rowToCase(book, 'S3'));
    } catch (error) {
      errors.push(`S3 ${language}: ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const noEpub: Case[] = [];
  for (let pageNumber = 1; pageNumber <= 10 && noEpub.length < 2; pageNumber += 1) {
    try {
      const page = await fetchJson<GutendexPage>(
        `https://gutendex.com/books?sort=popular&page=${pageNumber}`,
      );
      for (const book of page.results ?? []) {
        const sources = sourcesFromFormats(book.formats);
        if (sources.length && !sources.some((source) => source.kind === 'epub')) {
          noEpub.push(rowToCase(book, 'S4'));
          if (noEpub.length >= 2) break;
        }
      }
    } catch (error) {
      errors.push(`S4 page ${pageNumber}: ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  cases.push(...noEpub);

  for (const media of ['audio', 'image']) {
    try {
      const page = await fetchJson<GutendexPage>(
        `https://gutendex.com/books?mime_type=${media}&sort=popular`,
      );
      const book = (page.results ?? [])[0];
      if (book) {
        cases.push({
          id: `${book.id}`,
          title: book.title,
          languages: (book.languages ?? []).join(','),
          stratum: 'S5',
          sources: [],
          informational: true,
          note: `${media}-only edition`,
        });
      }
    } catch {
      /* optional stratum */
    }
  }

  return { cases, errors };
}

function fixtureCases(): Case[] {
  return [
    {
      id: 's6-empty',
      title: 'S6 empty payload',
      languages: '',
      stratum: 'S6',
      sources: [],
      expectedVerdict: 'unsupported_media',
      fixture: emptyBytes,
    },
    {
      id: 's6-png',
      title: 'S6 PNG payload',
      languages: '',
      stratum: 'S6',
      sources: [],
      expectedVerdict: 'unsupported_media',
      fixture: pngBytes,
    },
    {
      id: 's6-garbage',
      title: 'S6 1 KB garbage',
      languages: '',
      stratum: 'S6',
      sources: [],
      expectedVerdict: 'unsupported_media',
      fixture: garbageBytes,
    },
    {
      id: 's6-latin1',
      title: 'S6 Latin-1 PG excerpt',
      languages: 'en',
      stratum: 'S6',
      sources: [],
      expectedVerdict: 'low_text_quality',
      fixture: latin1Excerpt,
    },
    {
      id: 's6-no-markers',
      title: 'S6 missing licence markers',
      languages: 'en',
      stratum: 'S6',
      sources: [],
      expectedVerdict: 'low_text_quality',
      fixture: () => latin1Bytes(missingMarkersText()),
    },
    {
      id: 's6-large',
      title: 'S6 600k generated prose',
      languages: 'en',
      stratum: 'S6',
      sources: [],
      expectedVerdict: 'ready',
      fixture: () => latin1Bytes(largeProse(600_000)),
    },
  ];
}

function budgetFor(band: 'single' | 'b' | 'c' | 'd'): number {
  return { single: 28, b: 79, c: 123, d: 167 }[band];
}

async function runCase(input: Case): Promise<CaseResult> {
  const base: CaseResult = {
    id: input.id,
    title: input.title,
    languages: input.languages,
    stratum: input.stratum,
    format: '-',
    bytes: 0,
    chars: 0,
    words: 0,
    wordsPer1k: 0,
    printable: 0,
    script: 'unknown',
    markers: false,
    verdict: 'skipped',
    chunks: 0,
    segs: 0,
    maxSeg: 0,
    coverage: 0,
    parseMs: 0,
    planMs: 0,
    pass: false,
    reasons: [],
    required: input.stratum !== 'S5',
    informational: !!input.informational,
  };

  if (input.informational) {
    return { ...base, pass: true, reasons: [input.note ?? 'informational only'] };
  }

  let bytes: Uint8Array | null = null;
  let sniffed: SniffedFormat | null = null;

  if (input.fixture) {
    bytes = await input.fixture();
    sniffed = sniffBytes(bytes).format;
  } else {
    for (const url of input.sources) {
      try {
        const candidate = await fetchBytes(url);
        const sniff = sniffBytes(candidate, { name: url.split('/').pop() });
        if (sniff.format === 'image' || sniff.format === 'audio' || sniff.format === 'gzip') {
          base.reasons.push(`${url.split('/').pop()}:${sniff.format}`);
          continue;
        }
        if (sniff.format === 'unknown') continue;
        bytes = candidate;
        sniffed = sniff.format;
        break;
      } catch (error) {
        base.reasons.push(`${url.split('/').pop()}:${(error as Error).message}`);
      }
    }
  }

  if (!bytes || !sniffed) {
    return {
      ...base,
      pass: false,
      reasons: [...base.reasons, 'no readable candidate'],
    };
  }

  base.bytes = bytes.length;
  base.format = sniffed;

  const parseStarted = now();
  let text = '';
  let markersFound = false;
  let source: 'text' | 'html' | 'epub' = 'text';

  try {
    const sniff = sniffBytes(bytes);
    if (sniff.format === 'epub' || (sniff.format === 'zip' && input.sources.some((url) => /\.epub/.test(url)))) {
      const book = await parseEpub(bytes);
      source = 'epub';
      const boilerplates: boolean[] = [];
      const chapters: string[] = [];
      for (const chapter of book.chapters) {
        const stripped = stripGutenbergBoilerplate(chapter.text);
        boilerplates.push(stripped.start.found || stripped.end.found);
        if (wordCount(stripped.text) >= 5) chapters.push(stripped.text);
      }
      text = normalizeWhitespace(chapters.join('\n\n'));
      markersFound = boilerplates.some(Boolean);
    } else if (sniff.format === 'html') {
      const decoded = decodeBytes(bytes, { charset: sniff.charset });
      const cut = stripBoilerplateFromRawHtml(decoded.text);
      source = 'html';
      text = normalizeWhitespace(htmlToText(cut.cut));
      markersFound = cut.result.start.found || cut.result.end.found;
    } else {
      const decoded = decodeBytes(bytes, { charset: sniff.charset });
      const stripped = stripGutenbergBoilerplate(decoded.text);
      source = 'text';
      text = normalizeWhitespace(stripped.text);
      markersFound = stripped.start.found || stripped.end.found;
    }
  } catch (error) {
    const message =
      error instanceof EpubError ? `epub_${error.code}` : (error as Error).message;
    return { ...base, parseMs: now() - parseStarted, pass: false, reasons: [message] };
  }
  base.parseMs = now() - parseStarted;

  const assessment = assessTextQuality({
    text,
    source,
    markersFound,
    sniffedFormat: sniffed,
  });
  base.chars = assessment.metrics.chars;
  base.words = assessment.metrics.words;
  base.wordsPer1k = assessment.metrics.wordsPer1kChars;
  base.printable = assessment.metrics.printableRatio;
  base.script = assessment.metrics.script;
  base.markers = markersFound;
  base.verdict = assessment.verdict;

  const reasons = [...base.reasons];
  const checks: boolean[] = [];

  if (input.expectedVerdict) {
    checks.push(assessment.verdict === input.expectedVerdict);
    if (assessment.verdict !== input.expectedVerdict) {
      reasons.push(`verdict ${assessment.verdict} != ${input.expectedVerdict}`);
    }
  } else {
    const ok = assessment.verdict === 'ready' || assessment.verdict === 'low_text_quality';
    checks.push(ok);
    if (!ok) reasons.push(`verdict ${assessment.verdict}`);
  }

  const unsupportedExpected =
    input.expectedVerdict === 'unsupported_media' || input.expectedVerdict === 'needs_ocr';
  const textCase = text.length > 0 && !unsupportedExpected;

  if (textCase) {
    // Parse: at least one section's worth of text.
    checks.push(true);

    const forbidden = /\*\*\* START OF|END OF THE PROJECT GUTENBERG/i.test(text);
    // The pass criterion targets the PG licence header/footer, not incidental
    // body prose that happens to mention the archive (e.g. Moby-Dick's notes).
    const hasPgHeader = /(?:The\s+)?Project\s+Gutenberg\s+eBook/i.test(text.slice(0, 500));
    const allowMarkerMention =
      input.stratum === 'S6' && assessment.reasons.includes('no_licence_markers');
    const boilerOk = !forbidden && !(hasPgHeader && !allowMarkerMention);
    checks.push(boilerOk);
    if (!boilerOk) reasons.push('boilerplate');

    if (input.stratum !== 'S6') {
      const decodeOk =
        assessment.metrics.replacementRatio <= 0.01 && assessment.metrics.printableRatio >= 0.95;
      checks.push(decodeOk);
      if (!decodeOk) reasons.push('decode');
    }

    const planStarted = now();
    const chunks = chunkText(text, { targetChars: 900 });
    const script = extractiveSummary(text, { maxSentences: 12 }).join(' ');
    const tier = planTiers(text.length);
    const inputs = chunks.map((chunk, index) => ({ id: `c${index}`, text: chunk.text }));
    let coverageOk = true;
    let windows = [] as ReturnType<typeof planWindowsH>;
    try {
      if (inputs.length) {
        windows = planWindowsH(inputs, {
          maxWindows: tier.units0,
          minChars: 4_000,
          maxChars: tier.l0MaxChars,
          hardMaxChars: tier.l0MaxChars,
        });
        assertFullCoverage(windows, inputs.map((item) => item.id));
      }
    } catch {
      coverageOk = false;
      reasons.push('coverage');
    }
    const covered = chunks.reduce(
      (sum, chunk) => sum + Math.max(0, chunk.charEnd - chunk.charStart),
      0,
    );
    const coverage = text.length ? Math.min(1, covered / text.length) * 100 : 0;
    checks.push(coverageOk && coverage >= 97);
    if (coverage < 97) reasons.push(`coverage ${coverage.toFixed(1)}%`);

    const segments = planSpeechSegments(script, 480);
    const maxSeg = segments.reduce((max, piece) => Math.max(max, piece.text.length), 0);
    const inputNonSpace = script.replace(/\s/g, '').length;
    const segNonSpace = segments.map((piece) => piece.text).join('').replace(/\s/g, '').length;
    const segOk =
      script.length === 0 ||
      (segments.length > 0 &&
        segments.every((piece) => piece.text.length > 0 && piece.text.length <= 480) &&
        segNonSpace >= inputNonSpace * 0.99);
    checks.push(segOk);
    if (!segOk) reasons.push('segmentation');

    const hierarchyOk =
      tier.coverage === 'full' &&
      tier.estimatedCalls <= budgetFor(tier.band) &&
      windows.every((window) => window.chunkIds.length === 1 || window.charCount <= tier.l0MaxChars);
    checks.push(hierarchyOk);
    if (!hierarchyOk) reasons.push('hierarchy');

    if (input.stratum === 'S2' && text.length > 250_000) {
      const longOk = tier.units0 >= 2 && tier.levels >= 1;
      checks.push(longOk);
      if (!longOk) reasons.push('long book stayed single-tier');
    }

    base.planMs = now() - planStarted;
    base.chunks = chunks.length;
    base.segs = segments.length;
    base.maxSeg = maxSeg;
    base.coverage = coverage;
  }

  return {
    ...base,
    pass: checks.every(Boolean),
    reasons,
  };
}

function roundRobin(pools: Record<string, Case[]>, order: string[], limit: number): Case[] {
  const cursors: Record<string, number> = {};
  const out: Case[] = [];
  let index = 0;
  while (out.length < limit) {
    let progressed = false;
    for (const key of order) {
      if (out.length >= limit) break;
      const pool = pools[key] ?? [];
      const cursor = cursors[key] ?? 0;
      if (cursor < pool.length) {
        out.push(pool[cursor]);
        cursors[key] = cursor + 1;
        progressed = true;
      }
    }
    if (!progressed) break;
    index += 1;
    if (index > 200) break;
  }
  return out;
}

function percentage(values: boolean[]): number {
  if (!values.length) return 100;
  return (values.filter(Boolean).length / values.length) * 100;
}

function formatTable(results: CaseResult[]): string {
  const header =
    '| id | title | langs | format | bytes | chars | words | w/1k | printable | script | markers | verdict | chunks | segs | maxSeg | coverage% | parse ms | plan ms | pass | reason |';
  const rule =
    '|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|---|';
  const rows = results.map((result) =>
    [
      result.id,
      result.title.replace(/\|/g, '/').slice(0, 48),
      result.languages || '-',
      result.format,
      result.bytes,
      result.chars,
      result.words,
      result.wordsPer1k.toFixed(0),
      (result.printable * 100).toFixed(1),
      result.script,
      result.markers ? 'yes' : 'no',
      result.verdict,
      result.chunks,
      result.segs,
      result.maxSeg,
      result.coverage.toFixed(1),
      result.parseMs.toFixed(0),
      result.planMs.toFixed(0),
      result.pass ? 'PASS' : 'FAIL',
      result.reasons.join('; ').replace(/\|/g, '/').slice(0, 80),
    ].join(' | '),
  );
  return [header, rule, ...rows.map((row) => `| ${row} |`)].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string): string | null => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
  };

  const all = flag('all');
  const sample = Math.max(1, Number(value('sample') ?? (all ? 40 : 12)));
  const only = (value('only') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const jsonPath = value('json');

  let networkCases: Case[] = [];
  const selectionErrors: string[] = [];

  if (only.length) {
    networkCases = only.map((id) => ({
      id,
      title: `Gutenberg #${id}`,
      languages: '',
      stratum: 'S2' as const,
      sources: synthesiseGutenbergSources(id).map((source) => source.url),
    }));
  } else {
    const selected = await selectStrata();
    selectionErrors.push(...selected.errors);
    const pools: Record<string, Case[]> = {
      S1: selected.cases.filter((item) => item.stratum === 'S1'),
      S2: selected.cases.filter((item) => item.stratum === 'S2'),
      S3: selected.cases.filter((item) => item.stratum === 'S3'),
      S4: selected.cases.filter((item) => item.stratum === 'S4'),
      S5: selected.cases.filter((item) => item.stratum === 'S5'),
    };
    const required = roundRobin(pools, ['S1', 'S2', 'S3', 'S4'], sample);
    networkCases = [...required, ...pools.S5];
  }

  const fixtures = fixtureCases();
  const results: CaseResult[] = [];
  const allCases = [...networkCases, ...fixtures];

  for (const input of allCases) {
    process.stderr.write(`running ${input.stratum} ${input.id}…\n`);
    results.push(await runCase(input));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  process.stdout.write(`\n${formatTable(results)}\n\n`);

  const strata: Stratum[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  const thresholds: Record<Stratum, number> = { S1: 98, S2: 100, S3: 80, S4: 100, S5: 0, S6: 100 };
  const summary: string[] = [];
  let failed = false;

  for (const stratum of strata) {
    const rows = results.filter((result) => result.stratum === stratum && !result.informational);
    if (!rows.length) continue;
    const rate = percentage(rows.map((row) => row.pass));
    const threshold = thresholds[stratum];
    const ok = rate >= threshold;
    if (!ok) failed = true;
    summary.push(`${stratum}: ${rows.filter((row) => row.pass).length}/${rows.length} (${rate.toFixed(0)}%, need ${threshold}%)`);
  }

  for (const result of results) {
    if (result.stratum === 'S6' && !result.pass) failed = true;
  }
  // A failed optional lookup matters only when it leaves a required stratum
  // with no sampled rows at all.
  for (const stratum of ['S1', 'S2', 'S4'] as const) {
    const rows = results.filter((result) => result.stratum === stratum && !result.informational);
    if (!rows.length && selectionErrors.some((error) => error.startsWith(stratum))) {
      failed = true;
    }
  }
  if (selectionErrors.length) {
    summary.push(`selection warnings: ${selectionErrors.join('; ')}`);
  }
  if (!only.length) {
    const s4Rows = results.filter(
      (result) => result.stratum === 'S4' && !result.informational,
    );
    if (s4Rows.length < 2) summary.push(`NOTE: S4 found ${s4Rows.length}/2`);
  }

  const requiredRows = results.filter((result) => result.required && !result.informational);
  const slowest = [...requiredRows].sort((a, b) => b.parseMs - a.parseMs).slice(0, 3);
  summary.push(`books: ${networkCases.length} network + ${fixtures.length} synthetic`);
  summary.push(
    `slowest parse: ${slowest.map((row) => `${row.id} ${row.parseMs.toFixed(0)}ms`).join(', ') || 'none'}`,
  );

  process.stdout.write(`${summary.join(' · ')}\n`);
  process.stdout.write(`RESULT: ${failed ? 'FAIL' : 'PASS'}\n`);

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify({ results, summary, selectionErrors }, null, 2),
      'utf8',
    );
  }

  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`harness crashed: ${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
});
