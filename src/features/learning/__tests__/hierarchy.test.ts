/** @jest-environment node */
import type { AiProvider, AiRequest, AiResponse } from '@/ai/types';
import { createTestDriver } from '@/data/__tests__/testDriver';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import { upsertCatalogueBook } from '@/data/repositories/books';
import { replaceExtraction, saveDocument } from '@/data/repositories/reading';
import { chunkText } from '@/domain/text';
import type { Chunk, Section } from '@/domain/types';
import { largeBook } from '@/features/imports/__tests__/fixtures/gutenberg';
import { summariseBookDeep } from '@/features/learning/summarise';
import {
  HIERARCHY_ENABLED,
  assertFullCoverage,
  planTiers,
  planWindowsH,
} from '@/features/learning/windows';

const BOOK_ID = 'big-book';
const DOCUMENT_ID = 'big-document';

class HierarchyProvider implements AiProvider {
  readonly id = 'fake-hierarchy';
  readonly label = 'Fake hierarchy';
  calls: AiRequest[] = [];
  failMerge = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    if (request.task === 'notes') {
      return {
        text: request.sources
          .map((source) => `[${source.chunkId}] ${source.text.slice(0, 80)}`)
          .join('\n'),
        citations: [],
        provider: this.id,
      };
    }
    if (request.task === 'outline') {
      if (this.failMerge && request.sources[0]?.chunkId.startsWith('note:')) {
        throw new Error('merge group failed');
      }
      return {
        text: ['## Part 1', '- one', '## Part 2', '- two', '## Part 3', '- three'].join('\n'),
        citations: [],
        provider: this.id,
      };
    }
    if (request.task === 'script') {
      const target = Math.max(1, Math.round(request.targetWords ?? 100));
      return {
        text: Array.from({ length: target }, () => 'insight').join(' '),
        citations: [],
        provider: this.id,
      };
    }
    return { text: 'canned', citations: [], provider: this.id };
  }
}

let driver: ReturnType<typeof createTestDriver>;

beforeEach(async () => {
  driver = createTestDriver();
  await setDriverForTests(driver);
});

afterEach(async () => {
  await resetDriverForTests();
  try {
    await driver.close();
  } catch {
    /* closed */
  }
});

async function seedLargeBook(text: string) {
  await upsertCatalogueBook({
    id: BOOK_ID,
    provider: 'gutendex',
    title: 'Large Book',
    subjects: [],
    source: 'gutenberg',
    sourceId: '1',
    access: 'public_domain',
  });
  await saveDocument({
    id: DOCUMENT_ID,
    bookId: BOOK_ID,
    format: 'text',
    status: 'ready',
    importedAt: 0,
  });
  const pieces = chunkText(text, { targetChars: 900 });
  const section: Section = {
    id: 'big-section',
    documentId: DOCUMENT_ID,
    ordinal: 0,
    title: 'Whole Book',
    href: null,
    startPage: null,
    endPage: null,
    charStart: 0,
    charEnd: text.length,
    text,
  };
  const chunks: Chunk[] = pieces.map((piece, index) => ({
    id: `c${index}`,
    documentId: DOCUMENT_ID,
    sectionId: section.id,
    ordinal: index,
    text: piece.text,
    page: null,
    charStart: piece.charStart,
    charEnd: piece.charEnd,
  }));
  await replaceExtraction(DOCUMENT_ID, [section], chunks);
  return chunks;
}

describe('planTiers', () => {
  it('keeps the 100k plan identical to the explicit single band', () => {
    const plan = planTiers(100_000);
    expect(plan).toEqual(planTiers(100_000, { band: 'single' }));
    expect(plan.band).toBe('single');
    expect(plan.levels).toBe(0);
    expect(plan.units0).toBeLessThanOrEqual(18);
    expect(plan.groupCounts).toEqual([]);
    expect(plan.estimatedCalls).toBeLessThanOrEqual(28);
  });

  it('uses band b for a 600k book and stays inside its budget', () => {
    const plan = planTiers(600_000);
    expect(plan.band).toBe('b');
    expect(plan.levels).toBe(2);
    expect(plan.units0).toBeLessThanOrEqual(50);
    expect(plan.totalMergeUnits).toBeLessThanOrEqual(17);
    expect(plan.estimatedCalls).toBeLessThanOrEqual(79);
    expect(plan.coverage).toBe('full');
  });

  it('selects bands c and d by stripped character count', () => {
    const c = planTiers(1_000_000);
    expect(c.band).toBe('c');
    expect(c.estimatedCalls).toBeLessThanOrEqual(123);
    const d = planTiers(3_000_000);
    expect(d.band).toBe('d');
    expect(d.estimatedCalls).toBeLessThanOrEqual(167);
  });

  it('rejects books above four million characters', () => {
    expect(() => planTiers(5_000_000)).toThrow(/too_large/);
  });

  it('exposes the hierarchy flag', () => {
    expect(HIERARCHY_ENABLED).toBe(true);
  });
});

describe('planWindowsH', () => {
  it('covers 600k characters inside the band cap', () => {
    const text = largeBook(600_000);
    const chunks = chunkText(text, { targetChars: 900 });
    const plan = planTiers(text.length);
    const inputs = chunks.map((chunk, index) => ({ id: `c${index}`, text: chunk.text }));
    const windows = planWindowsH(inputs, {
      maxWindows: plan.units0,
      minChars: 4_000,
      maxChars: plan.l0MaxChars,
      hardMaxChars: plan.l0MaxChars,
    });

    expect(windows.length).toBeGreaterThan(1);
    assertFullCoverage(windows, inputs.map((input) => input.id));
    for (const window of windows) {
      if (window.chunkIds.length === 1) continue;
      expect(window.charCount).toBeLessThanOrEqual(plan.l0MaxChars);
    }
    // Overlapping source chunks may need a few more windows than the estimate;
    // the band cap (50) and the hard per-call limit still hold.
    expect(windows.length).toBeLessThanOrEqual(50);
  });
});

describe('hierarchical summarisation', () => {
  it('runs map → merge → reduce → expand and keeps every level-0 chunk', async () => {
    const chunks = await seedLargeBook(largeBook(600_000));
    const provider = new HierarchyProvider();
    const output = await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider,
      persist: false,
    });

    expect(output.text).toContain('## Part');
    expect(output.sourceChunkIds.length).toBe(chunks.length);
    expect(output.sourceChunkIds.length).toBeLessThanOrEqual(2_000);
    expect(provider.calls.some((call) => call.task === 'outline')).toBe(true);
    expect(output.calls).toBeLessThanOrEqual(79);
  });

  it('falls back to concatenated child notes when a merge group fails', async () => {
    await seedLargeBook(largeBook(600_000));
    const provider = new HierarchyProvider();
    provider.failMerge = true;
    const output = await summariseBookDeep({
      bookId: BOOK_ID,
      kind: 'summary',
      targetWords: 700,
      provider,
      persist: false,
    });

    expect(output.text.trim().length).toBeGreaterThan(0);
    expect(output.text).toContain('## Part');
    expect(output.degraded).toBe(true);
  });
});
