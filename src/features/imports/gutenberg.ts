/**
 * Project Gutenberg licence boilerplate stripping.
 *
 * Only recognised START/END markers are cut. When markers are absent the text
 * is returned unchanged (apart from a real `Produced by` header line) so a
 * marker-less file never loses body prose.
 */

export type BoilerplateWarning =
  | 'no_start_marker'
  | 'no_end_marker'
  | 'no_licence_markers'
  | 'end_before_start'
  | 'suspicious_cut';

export type BoilerplateResult = {
  text: string;
  start: { found: boolean; index: number | null };
  end: { found: boolean; index: number | null };
  producedBy: { found: boolean; removedChars: number };
  removedChars: number;
  warnings: BoilerplateWarning[];
  /** True when the computed body was implausibly small and the original was kept. */
  suspiciousCut: boolean;
};

type MarkerMatch = { index: number; raw: string };

// The optional HTML-comment opener lets the same anchors match PG's
// `<!-- *** START OF ... *** -->` form; comments are stripped later.
const COMMENT = '(?:<!--[ \\t]*)?';

const START_PATTERNS = [
  new RegExp(
    `^[ \\t]*${COMMENT}\\*{0,3}[ \\t]*(?:START|Start)[ \\t]+OF[ \\t]+(?:THE|THIS)[ \\t]+PROJECT[ \\t]+GUTENBERG[ \\t]+EBOOK\\b[^\\n]*$`,
    'im',
  ),
  new RegExp(
    `^[ \\t]*${COMMENT}\\*{0,3}[ \\t]*START[ \\t]+OF[ \\t]+THE[ \\t]+PROJECT[ \\t]+GUTENBERG[ \\t]+E-?BOOK\\b[^\\n]*$`,
    'im',
  ),
];

const END_PATTERNS = [
  new RegExp(
    `^[ \\t]*${COMMENT}\\*{0,3}[ \\t]*(?:END|End)[ \\t]+OF[ \\t]+(?:THE|THIS)[ \\t]+PROJECT[ \\t]+GUTENBERG[ \\t]+EBOOK\\b[^\\n]*$`,
    'im',
  ),
  new RegExp(
    `^[ \\t]*${COMMENT}End[ \\t]+of[ \\t]+(?:the[ \\t]+)?Project[ \\t]+Gutenberg(?:'s)?[ \\t]+E-?Book\\b[^\\n]*$`,
    'im',
  ),
];

const FOOTER_PATTERNS = [
  new RegExp(
    `^[ \\t]*${COMMENT}\\*{0,3}[ \\t]*END[ \\t]+OF[ \\t]+THE[ \\t]+PROJECT[ \\t]+GUTENBERG[ \\t]+LICEN[CS]E[^\\n]*$`,
    'im',
  ),
  new RegExp(`^[ \\t]*${COMMENT}THE[ \\t]+END[ \\t]*$`, 'im'),
  new RegExp(`^[ \\t]*${COMMENT}\\*\\*\\*[ \\t]*END[ \\t]*\\*\\*\\*[ \\t]*$`, 'im'),
];

const PRODUCED_BY = /^[ \t]*Produced[ \t]+by[ \t]+[^\n]{0,300}$/gim;

function firstMatch(text: string, patterns: RegExp[]): MarkerMatch | null {
  let best: MarkerMatch | null = null;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (!match) continue;
    if (!best || match.index < best.index) best = { index: match.index, raw: match[0] };
  }
  return best;
}

function footerMatch(text: string): MarkerMatch | null {
  let best: MarkerMatch | null = null;
  for (const pattern of FOOTER_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (!match) continue;
    const isFinalLine = /THE[ \t]+END|\*\*\*[ \t]*END[ \t]*\*\*\*/i.test(match[0]);
    if (isFinalLine && match.index <= text.length * 0.9) continue;
    if (!best || match.index < best.index) best = { index: match.index, raw: match[0] };
  }
  return best;
}

export function findGutenbergMarkers(haystack: string): {
  start: number | null;
  end: number | null;
  startRaw: string | null;
  endRaw: string | null;
} {
  const start = firstMatch(haystack, START_PATTERNS);
  const end = firstMatch(haystack, END_PATTERNS) ?? footerMatch(haystack);
  return {
    start: start?.index ?? null,
    end: end?.index ?? null,
    startRaw: start?.raw ?? null,
    endRaw: end?.raw ?? null,
  };
}

function lineEndAfter(text: string, match: MarkerMatch): number {
  let index = match.index + match.raw.length;
  if (text[index] === '\r') index += 1;
  if (text[index] === '\n') index += 1;
  return index;
}

function stripProducedBy(body: string, limit: number): { text: string; found: boolean; removedChars: number } {
  let found = false;
  let removed = 0;
  let out = '';
  let cursor = 0;
  for (;;) {
    PRODUCED_BY.lastIndex = cursor;
    const match = PRODUCED_BY.exec(body);
    if (!match) break;
    if (match.index >= limit) break;
    found = true;
    out += body.slice(cursor, match.index);
    let end = match.index + match[0].length;
    // Remove up to two following blank lines.
    let blankLines = 0;
    while (blankLines < 2) {
      const rest = body.slice(end);
      const newline = rest.match(/^\r?\n[ \t]*(?=\r?\n|$)/);
      if (!newline) break;
      end += newline[0].length;
      blankLines += 1;
    }
    removed += end - match.index;
    cursor = end;
  }
  out += body.slice(cursor);
  return { text: out, found, removedChars: removed };
}

export function stripGutenbergBoilerplate(text: string): BoilerplateResult {
  const markers = findGutenbergMarkers(text);
  const startMatch = markers.start !== null ? { index: markers.start, raw: markers.startRaw ?? '' } : null;
  const endMatch = markers.end !== null ? { index: markers.end, raw: markers.endRaw ?? '' } : null;
  const warnings: BoilerplateWarning[] = [];

  let bodyStart = 0;
  let bodyEnd = text.length;
  let endBeforeStart = false;

  if (startMatch && endMatch) {
    if (endMatch.index <= startMatch.index) {
      warnings.push('end_before_start');
      endBeforeStart = true;
    } else {
      bodyStart = lineEndAfter(text, startMatch);
      bodyEnd = endMatch.index;
    }
  } else if (startMatch) {
    bodyStart = lineEndAfter(text, startMatch);
    warnings.push('no_end_marker');
  } else if (endMatch) {
    bodyEnd = endMatch.index;
    warnings.push('no_start_marker');
  } else {
    warnings.push('no_licence_markers');
  }

  if (bodyEnd < bodyStart) bodyEnd = bodyStart;
  let body = text.slice(bodyStart, bodyEnd);
  let producedFound = false;
  let producedRemoved = 0;

  // `Produced by` is only page furniture in the header: before the start
  // marker, or in the first 5% when no start marker exists.
  if (!startMatch) {
    const limit = Math.floor(text.length * 0.05);
    const produced = stripProducedBy(body, limit);
    body = produced.text;
    producedFound = produced.found;
    producedRemoved = produced.removedChars;
  }

  const hadMarkers = !!startMatch || !!endMatch;
  if (hadMarkers) body = body.trim();
  if (hadMarkers && (endBeforeStart || (body.length < 200 && text.length > 2_000))) {
    return {
      text,
      start: { found: !!startMatch, index: startMatch?.index ?? null },
      end: { found: !!endMatch, index: endMatch?.index ?? null },
      producedBy: { found: producedFound, removedChars: 0 },
      removedChars: 0,
      warnings: [...new Set<BoilerplateWarning>([...warnings, 'suspicious_cut'])],
      suspiciousCut: true,
    };
  }

  return {
    text: body,
    start: { found: !!startMatch, index: startMatch?.index ?? null },
    end: { found: !!endMatch, index: endMatch?.index ?? null },
    producedBy: { found: producedFound, removedChars: producedRemoved },
    removedChars: text.length - body.length,
    warnings,
    suspiciousCut: false,
  };
}

/**
 * Marker cut on raw HTML, before tags/comments are stripped. Markers frequently
 * live inside HTML comments, so detection must run on the untouched string.
 */
export function stripBoilerplateFromRawHtml(raw: string): {
  cut: string;
  result: BoilerplateResult;
} {
  const result = stripGutenbergBoilerplate(raw);
  return { cut: result.text, result };
}
