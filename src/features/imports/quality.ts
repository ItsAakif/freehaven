/**
 * Import quality gate.
 *
 * Separates "we extracted text but it is short/uneven" (`low_text_quality`,
 * reading still works) from "there is no text layer" (`needs_ocr`) and "this
 * edition has no readable text" (`unsupported_media`).
 */

import { splitSentences, wordCount } from '../../domain/text';

export type ImportQuality = 'ready' | 'low_text_quality' | 'needs_ocr' | 'unsupported_media';

export type TextScript =
  | 'latin'
  | 'cyrillic'
  | 'greek'
  | 'arabic'
  | 'hebrew'
  | 'han'
  | 'hiragana'
  | 'katakana'
  | 'hangul'
  | 'devanagari'
  | 'thai'
  | 'other'
  | 'unknown';

export type QualityMetrics = {
  chars: number;
  words: number;
  wordsPer1kChars: number;
  printableRatio: number;
  letterRatio: number;
  replacementRatio: number;
  script: TextScript;
  dominantScriptRatio: number;
  rtl: boolean;
  noSentenceBoundaries: boolean;
};

export type NarrationEligibility = {
  allowed: boolean;
  maxLength: '5' | '15' | '25' | null;
  reason: 'too_short' | 'needs_ocr' | 'unsupported_media' | 'low_quality' | null;
};

export type QualityAssessment = {
  verdict: ImportQuality;
  metrics: QualityMetrics;
  reasons: string[];
  narration: NarrationEligibility;
};

type Bucket = Exclude<TextScript, 'other' | 'unknown'>;

const SCRIPT_ORDER: Bucket[] = [
  'latin',
  'cyrillic',
  'greek',
  'arabic',
  'hebrew',
  'han',
  'hiragana',
  'katakana',
  'hangul',
  'devanagari',
  'thai',
];

function scriptOf(code: number): Bucket | null {
  if (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0xc0 && code <= 0x24f) ||
    (code >= 0x1e00 && code <= 0x1eff)
  ) {
    return 'latin';
  }
  if ((code >= 0x400 && code <= 0x52f) || (code >= 0x2de0 && code <= 0x2dff)) return 'cyrillic';
  if ((code >= 0x370 && code <= 0x3ff) || (code >= 0x1f00 && code <= 0x1fff)) return 'greek';
  if (
    (code >= 0x600 && code <= 0x6ff) ||
    (code >= 0x750 && code <= 0x77f) ||
    (code >= 0x8a0 && code <= 0x8ff) ||
    (code >= 0xfb50 && code <= 0xfdff) ||
    (code >= 0xfe70 && code <= 0xfeff)
  ) {
    return 'arabic';
  }
  if (code >= 0x590 && code <= 0x5ff) return 'hebrew';
  if (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  ) {
    return 'han';
  }
  if (code >= 0x3040 && code <= 0x309f) return 'hiragana';
  if ((code >= 0x30a0 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) return 'katakana';
  if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f)) {
    return 'hangul';
  }
  if (code >= 0x900 && code <= 0x97f) return 'devanagari';
  if (code >= 0xe00 && code <= 0xe7f) return 'thai';
  return null;
}

function isLetter(code: number): boolean {
  return scriptOf(code) !== null;
}

function isNumber(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0xb2 && code <= 0xb3) ||
    (code >= 0xbc && code <= 0xbe) ||
    (code >= 0x660 && code <= 0x669) ||
    (code >= 0x6f0 && code <= 0x6f9) ||
    (code >= 0x966 && code <= 0x96f) ||
    (code >= 0xff10 && code <= 0xff19)
  );
}

function isPunctuation(code: number): boolean {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e) ||
    (code >= 0xa1 && code <= 0xbf) ||
    (code >= 0x2010 && code <= 0x2027) ||
    (code >= 0x2030 && code <= 0x205e) ||
    (code >= 0x3001 && code <= 0x303f) ||
    (code >= 0xff01 && code <= 0xff0f) ||
    (code >= 0xff1a && code <= 0xff20)
  );
}

function isPrintableCode(code: number): boolean {
  if (code === 0x0a || code === 0x0d || code === 0x09 || code === 0x20) return true;
  return isLetter(code) || isNumber(code) || isPunctuation(code);
}

function isReplacementCode(code: number): boolean {
  if (code === 0xfffd) return true;
  return code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09;
}

function metricsOf(text: string): QualityMetrics {
  const chars = text.length;
  const words = wordCount(text);
  let printable = 0;
  let letters = 0;
  let replacements = 0;
  const counts: Record<Bucket, number> = {
    latin: 0,
    cyrillic: 0,
    greek: 0,
    arabic: 0,
    hebrew: 0,
    han: 0,
    hiragana: 0,
    katakana: 0,
    hangul: 0,
    devanagari: 0,
    thai: 0,
  };

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isPrintableCode(code)) printable += 1;
    if (isReplacementCode(code)) replacements += 1;
    const bucket = scriptOf(code);
    if (bucket) {
      counts[bucket] += 1;
      letters += 1;
    }
  }

  let script: TextScript = 'unknown';
  let dominant = 0;
  for (const bucket of SCRIPT_ORDER) {
    if (counts[bucket] > dominant) {
      dominant = counts[bucket];
      script = bucket;
    }
  }
  if (script === 'unknown' && chars > 0) script = 'other';

  const totalLetters = letters;
  const maybeCjk = script === 'han' || script === 'hiragana' || script === 'katakana' || script === 'thai';
  const noSentenceBoundaries = maybeCjk && splitSentences(text).length < 5;

  return {
    chars,
    words,
    wordsPer1kChars: words * 1000 / Math.max(1, chars),
    printableRatio: chars ? printable / chars : 0,
    letterRatio: chars ? letters / chars : 0,
    replacementRatio: chars ? replacements / chars : 0,
    script,
    dominantScriptRatio: totalLetters ? dominant / totalLetters : 0,
    rtl: totalLetters ? (counts.arabic + counts.hebrew) / totalLetters >= 0.2 : false,
    noSentenceBoundaries,
  };
}

function narrationFor(verdict: ImportQuality, words: number): NarrationEligibility {
  if (verdict === 'needs_ocr') {
    return { allowed: false, maxLength: null, reason: 'needs_ocr' };
  }
  if (verdict === 'unsupported_media') {
    return { allowed: false, maxLength: null, reason: 'unsupported_media' };
  }
  if (words < 750) {
    return { allowed: false, maxLength: null, reason: 'too_short' };
  }
  if (verdict === 'ready') {
    if (words >= 3_000) return { allowed: true, maxLength: '25', reason: null };
    if (words >= 1_800) return { allowed: true, maxLength: '15', reason: null };
  }
  return { allowed: true, maxLength: '5', reason: null };
}

export function assessTextQuality(input: {
  text: string;
  source: 'text' | 'html' | 'epub' | 'pdf';
  pageCount?: number;
  markersFound: boolean;
  /** Optional sniffed format so image/audio payloads short-circuit to unsupported. */
  sniffedFormat?: string | null;
  /** Optional EPUB error code mapped by the caller. */
  epubErrorCode?: string | null;
}): QualityAssessment {
  const metrics = metricsOf(input.text);
  const reasons: string[] = [];
  if (!input.markersFound) reasons.push('no_licence_markers');

  const unsupportedByPayload =
    input.sniffedFormat === 'image' ||
    input.sniffedFormat === 'audio' ||
    input.sniffedFormat === 'gzip';
  const unsupportedByEpub =
    input.epubErrorCode === 'no_readable_chapters' ||
    input.epubErrorCode === 'too_large' ||
    input.epubErrorCode === 'drm_protected';

  let verdict: ImportQuality;
  if (unsupportedByPayload || unsupportedByEpub) {
    verdict = 'unsupported_media';
    reasons.push('unsupported_media');
  } else if (metrics.words < 20 && metrics.printableRatio < 0.6) {
    verdict = 'unsupported_media';
    reasons.push('unsupported_media');
  } else if (input.source === 'pdf' && (input.pageCount ?? 1) >= 1 && metrics.words < 50) {
    verdict = 'needs_ocr';
    reasons.push('needs_ocr');
  } else if (
    metrics.words < 1_500 ||
    metrics.wordsPer1kChars < 120 ||
    metrics.printableRatio < 0.95 ||
    metrics.replacementRatio > 0.01 ||
    metrics.letterRatio < 0.5
  ) {
    verdict = 'low_text_quality';
    if (metrics.words < 1_500) reasons.push('too_few_words');
    if (metrics.wordsPer1kChars < 120) reasons.push('low_words_per_1k');
    if (metrics.printableRatio < 0.95) reasons.push('low_printable_ratio');
    if (metrics.replacementRatio > 0.01) reasons.push('replacement_characters');
    if (metrics.letterRatio < 0.5) reasons.push('low_letter_ratio');
  } else {
    verdict = 'ready';
  }

  if (metrics.noSentenceBoundaries) reasons.push('no_sentence_boundaries');

  return {
    verdict,
    metrics,
    reasons,
    narration: narrationFor(verdict, metrics.words),
  };
}
