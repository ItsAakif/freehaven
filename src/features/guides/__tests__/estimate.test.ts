/** @jest-environment node */
import {
  estimateChapterCount,
  estimateGuideBuild,
  estimateGuideCopy,
} from '@/features/guides/estimate';

describe('guide estimate', () => {
  it('reports the 20 × 250 defaults', () => {
    const estimate = estimateGuideBuild({
      chapters: 20,
      wordsPerChapter: 250,
      engine: 'remote',
    });
    expect(estimate.chapters).toBe(20);
    expect(estimate.words).toBe(5_000);
    expect(estimate.audioMinutes).toBe(34.5);
    expect(estimate.modelCalls).toBe(100);
    expect(estimate.segments).toBe(20);
    expect(estimate.synthPriorMs).toBe(110_000);
    expect(estimate.synthLowMs).toBe(55_000);
    expect(estimate.synthHighMs).toBe(165_000);
    expect(estimate.scriptLowMs).toBe(600_000);
    expect(estimate.scriptHighMs).toBe(1_800_000);
    expect(estimate.synthLowMs).toBeLessThan(estimate.synthPriorMs);
    expect(estimate.synthPriorMs).toBeLessThan(estimate.synthHighMs);
  });

  it('uses the existing per-engine segment caps and priors', () => {
    const kokoro = estimateGuideBuild({ chapters: 20, wordsPerChapter: 250, engine: 'kokoro' });
    expect(kokoro.segments).toBe(60);
    expect(kokoro.synthPriorMs).toBe(3_600_000);
    expect(kokoro.synthLowMs).toBe(720_000);
    expect(kokoro.synthHighMs).toBe(6_480_000);

    const piper = estimateGuideBuild({ chapters: 20, wordsPerChapter: 250, engine: 'piper' });
    expect(piper.segments).toBe(40);
    expect(piper.synthPriorMs).toBe(560_000);
    expect(piper.synthLowMs).toBe(364_000);
    expect(piper.synthHighMs).toBe(756_000);

    const device = estimateGuideBuild({ chapters: 20, wordsPerChapter: 250, engine: 'device' });
    expect(device.segments).toBe(80);
    expect(device.synthPriorMs).toBe(4_800);
    expect(device.synthLowMs).toBe(4_320);
    expect(device.synthHighMs).toBe(5_280);
  });

  it('writes short and detailed copy that names the engine', () => {
    const kokoro = estimateGuideCopy(
      estimateGuideBuild({ chapters: 20, wordsPerChapter: 250, engine: 'kokoro' }),
      'kokoro',
    );
    expect(kokoro.short).toBe('20 chapters · 5,000 words · ~35 min of audio');
    expect(kokoro.detail).toBe(
      'About 10–30 min to write, then about 1–2 hr for Kokoro audio.',
    );

    const remote = estimateGuideCopy(
      estimateGuideBuild({ chapters: 20, wordsPerChapter: 250, engine: 'remote' }),
      'remote',
    );
    expect(remote.detail).toBe('About 10–30 min to write, then about 1–3 min for Remote audio.');

    const device = estimateGuideCopy(
      estimateGuideBuild({ chapters: 20, wordsPerChapter: 250, engine: 'device' }),
      'device',
    );
    expect(device.detail).toBe('About 10–30 min to write, then instant for Device audio.');
  });

  it('derives a chapter count from the document shape', () => {
    expect(estimateChapterCount({ format: 'pdf', pageCount: 253, sectionCount: 253 })).toBe(21);
    expect(estimateChapterCount({ format: 'pdf', pageCount: null, sectionCount: 600 })).toBe(40);
    expect(estimateChapterCount({ format: 'pdf', pageCount: 24, sectionCount: 24 })).toBe(3);
    expect(estimateChapterCount({ format: 'epub', pageCount: null, sectionCount: 12 })).toBe(12);
    expect(estimateChapterCount({ format: 'text', pageCount: null, sectionCount: 0 })).toBe(1);
  });
});
