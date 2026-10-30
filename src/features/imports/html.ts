/**
 * Regex-based HTML→text conversion tuned for Project Gutenberg markup.
 *
 * Not a general browser parser (explicit non-goal). Removes page furniture,
 * preserves `<pre>`/`<code>` whitespace for poetry, decodes entities and emits
 * blank-line block boundaries.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  sup2: '\u00b2',
  sup3: '\u00b3',
  micro: '\u00b5',
  para: '\u00b6',
  sect: '\u00a7',
  middot: '\u00b7',
  bull: '\u2022',
  dagger: '\u2020',
  Dagger: '\u2021',
  laquo: '\u00ab',
  raquo: '\u00bb',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  szlig: '\u00df',
  agrave: '\u00e0',
  aacute: '\u00e1',
  acirc: '\u00e2',
  atilde: '\u00e3',
  auml: '\u00e4',
  aring: '\u00e5',
  aelig: '\u00e6',
  ccedil: '\u00e7',
  egrave: '\u00e8',
  eacute: '\u00e9',
  ecirc: '\u00ea',
  euml: '\u00eb',
  igrave: '\u00ec',
  iacute: '\u00ed',
  icirc: '\u00ee',
  iuml: '\u00ef',
  ntilde: '\u00f1',
  ograve: '\u00f2',
  oacute: '\u00f3',
  ocirc: '\u00f4',
  otilde: '\u00f5',
  ouml: '\u00f6',
  oslash: '\u00f8',
  ugrave: '\u00f9',
  uacute: '\u00fa',
  ucirc: '\u00fb',
  uuml: '\u00fc',
  yacute: '\u00fd',
  yuml: '\u00ff',
};

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '\ufffd';
  return String.fromCodePoint(code);
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => {
      const value = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()];
      return value ?? match;
    });
}

function collapseWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, '');
}

const BLOCK_CLOSE =
  /<\/(p|div|h[1-6]|blockquote|section|article|li|tr|table|ul|ol|dl|dd|dt|figure|figcaption|address)>/gi;
const FURNITURE_BLOCK =
  /<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi;
const DROP_BLOCK =
  /<(script|style|noscript|svg|iframe|object|embed|canvas|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const CLASS_FURNITURE =
  /<(div|section|aside|ul|ol|table|p)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:toc|navigation|pgheader|pgfooter|nav)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
const ROLE_NAVIGATION =
  /<(div|section|aside|ul|ol|nav)\b[^>]*role\s*=\s*["']?navigation[^>]*>[\s\S]*?<\/\1>/gi;
const PRE_BLOCK = /<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/gi;

export function htmlToText(
  html: string,
  options: { preservePre?: boolean; blockSeparator?: '\n' | '\n\n' } = {},
): string {
  if (!html || !html.trim()) return '';
  const preservePre = options.preservePre !== false;
  const separator = options.blockSeparator ?? '\n\n';
  const placeholders: string[] = [];

  let working = html.replace(PRE_BLOCK, (_, _tag: string, inner: string) => {
    const plain = decodeEntities(stripTags(inner));
    placeholders.push(plain);
    return `\uE000PRE${placeholders.length - 1}\uE001`;
  });

  working = working
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_BLOCK, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<(link|meta)\b[^>]*>/gi, '')
    .replace(FURNITURE_BLOCK, '')
    .replace(CLASS_FURNITURE, '')
    .replace(ROLE_NAVIGATION, '')
    .replace(BLOCK_CLOSE, separator)
    .replace(/<hr\b[^>]*\/?>/gi, separator)
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\u2022 ')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<tr\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  working = decodeEntities(working);
  working = collapseWhitespace(working);

  if (placeholders.length) {
    working = working.replace(/\uE000PRE(\d+)\uE001/g, (_, index: string) => {
      const content = placeholders[Number(index)] ?? '';
      if (!content) return '';
      const body = preservePre
        ? content.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '')
        : content.replace(/\s+/g, ' ').trim();
      return `\n\n${body}\n\n`;
    });
    working = working.replace(/\n{3,}/g, '\n\n').trim();
  }

  return working;
}

function firstMatch(input: string, pattern: RegExp): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(input);
}

export function htmlTitle(html: string): string | null {
  const match = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = collapseWhitespace(decodeEntities(stripTags(match[1])));
  return title || null;
}

function metaContent(html: string, name: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const reverse = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`,
    'i',
  );
  const match = firstMatch(html, pattern) ?? firstMatch(html, reverse);
  return match ? decodeEntities(match[1]).trim() || null : null;
}

export function htmlMeta(html: string): {
  charset: string | null;
  title: string | null;
  author: string | null;
  language: string | null;
} {
  const head = html.slice(0, 8 * 1024);
  const direct = firstMatch(head, /<meta[^>]+charset\s*=\s*["']?([a-z0-9_\-]+)/i);
  const content = firstMatch(head, /<meta[^>]+content\s*=\s*["'][^"']*charset=([a-z0-9_\-]+)/i);
  const langAttr = firstMatch(head, /<html[^>]+lang\s*=\s*["']([^"']+)["']/i);
  return {
    charset: (direct?.[1] ?? content?.[1] ?? null)?.toLowerCase() ?? null,
    title: htmlTitle(html),
    author:
      metaContent(html, 'author') ??
      metaContent(html, 'dc.creator') ??
      metaContent(html, 'dcterms.creator'),
    language:
      langAttr?.[1]?.trim() ??
      metaContent(html, 'dc.language') ??
      metaContent(html, 'content-language') ??
      null,
  };
}
