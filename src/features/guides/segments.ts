/**
 * Guide chapter segment planning.
 *
 * Pure apart from the lazy preference read inside `buildSpeechRequest`. The
 * speech key is computed from the exact request synthesis will send, so a
 * planned segment and its produced file can never disagree.
 */

import type { QueuedSegment, RenditionEngine } from '@/domain/narration';
import type { Guide, GuideChapter } from '@/domain/guides';
import { splitScriptBlocks } from '@/features/narration/generate';
import { maxCharsForEngine, planSpeechSegments } from '@/features/narration/segments';
import { speechCacheKey } from '@/features/narration/cacheKey';
import { instructionHash } from '@/features/narration/script';
import { getNarrationStyle } from '@/features/narration/styles';
import { buildSpeechRequest, engineFormat, remoteBaseUrl } from '@/features/narration/speechRequest';

export function planChapterSegments(input: {
  guide: Guide;
  chapter: Pick<GuideChapter, 'id' | 'title' | 'summaryMd'>;
  engine: RenditionEngine;
}): QueuedSegment[] {
  const summary = input.chapter.summaryMd?.trim();
  if (!summary) throw new Error('Guide chapter has no script.');

  const { guide, chapter, engine } = input;
  const style = getNarrationStyle(guide.styleId);
  const maxChars = maxCharsForEngine(engine);
  const format = engineFormat(engine);
  const baseUrl = engine === 'remote' ? remoteBaseUrl() : undefined;
  const emptyInstructionHash = instructionHash('');

  let blocks = splitScriptBlocks(summary);
  if (!blocks.length) blocks = [{ heading: null, text: summary }];

  const out: QueuedSegment[] = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const pieces = planSpeechSegments(block.text, maxChars);
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex];
      const request = buildSpeechRequest({
        engine,
        styleId: style.id,
        language: guide.language,
        voice: guide.voice,
        model: guide.model,
        instruction: null,
        instructionHash: emptyInstructionHash,
        text: piece.text,
        format,
        baseUrl,
      });
      out.push({
        sectionId: null,
        sectionOrdinal: 0,
        title: blockIndex === 0 && pieceIndex === 0 ? chapter.title : null,
        text: piece.text,
        speechKey: speechCacheKey(request),
      });
    }
  }
  return out;
}
