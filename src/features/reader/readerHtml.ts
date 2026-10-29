/**
 * Reader HTML + bridge.
 *
 * Text is rendered as semantic paragraphs with character offsets, so a text
 * selection can be mapped back to a stable locator (section + paragraph +
 * offset) and highlights survive restarts. Kept as a pure function so the
 * generated document can be snapshot-tested.
 */

export type ReaderHighlight = { id: string; para: number; start: number; end: number; color: string };

export type ReaderSettings = {
  fontSize: number;
  lineHeight: number;
  theme: 'light' | 'dark' | 'reading';
  fontFamily: 'serif' | 'sans';
  maxWidth: number;
};

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.65,
  theme: 'reading',
  fontFamily: 'serif',
  maxWidth: 680,
};

const THEMES = {
  light: { bg: '#FFFDF8', ink: '#1B1813', muted: '#6B6355', rule: '#E2D8C6', mark: 'rgba(192,138,62,0.28)' },
  dark: { bg: '#12110F', ink: '#F3EDE2', muted: '#A79E8E', rule: '#332F27', mark: 'rgba(217,174,107,0.26)' },
  reading: { bg: '#F1E6D0', ink: '#2B2418', muted: '#6E6250', rule: '#DCCDB0', mark: 'rgba(185,138,69,0.30)' },
} as const;

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Split section text into readable paragraphs without losing content. */
export function splitParagraphs(text: string): string[] {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+\n\s+/g, ' ').trim())
    .filter(Boolean);
  if (blocks.length > 1) return blocks;
  // Some PDFs arrive as one long blob; break on sentence groups of ~450 chars.
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["')\]]*|\S+$/g) ?? [text];
  const out: string[] = [];
  let buffer = '';
  for (const sentence of sentences) {
    if ((buffer + sentence).length > 480 && buffer) {
      out.push(buffer.trim());
      buffer = '';
    }
    buffer += sentence;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

/** Wrap highlight ranges inside one paragraph. Ranges are clamped and sorted. */
export function applyHighlights(text: string, highlights: ReaderHighlight[]): string {
  const valid = highlights
    .map((h) => ({
      ...h,
      start: Math.max(0, Math.min(text.length, h.start)),
      end: Math.max(0, Math.min(text.length, h.end)),
    }))
    .filter((h) => h.end > h.start)
    .sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const h of valid) {
    if (h.start < cursor) continue;
    out += escapeHtml(text.slice(cursor, h.start));
    out += `<mark data-id="${escapeHtml(h.id)}" class="hl hl-${escapeHtml(h.color)}">${escapeHtml(
      text.slice(h.start, h.end),
    )}</mark>`;
    cursor = h.end;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}

export function buildReaderHtml(input: {
  title: string;
  sectionTitle: string;
  paragraphs: string[];
  highlights: ReaderHighlight[];
  settings: ReaderSettings;
  initialScroll?: number;
}): string {
  const theme = THEMES[input.settings.theme];
  const font = input.settings.fontFamily === 'serif' ? 'Georgia, "Times New Roman", serif' : 'System, -apple-system, "Segoe UI", sans-serif';
  const body = input.paragraphs
    .map((paragraph, index) => {
      const inner = applyHighlights(
        paragraph,
        input.highlights.filter((h) => h.para === index),
      );
      return `<p data-p="${index}">${inner}</p>`;
    })
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  :root { color-scheme: ${input.settings.theme === 'dark' ? 'dark' : 'light'}; }
  html, body { margin: 0; padding: 0; background: ${theme.bg}; color: ${theme.ink}; }
  body {
    font-family: ${font};
    font-size: ${input.settings.fontSize}px;
    line-height: ${input.settings.lineHeight};
    padding: 20px 22px 120px 22px;
    max-width: ${input.settings.maxWidth}px;
    margin: 0 auto;
    -webkit-text-size-adjust: 100%;
    text-rendering: optimizeLegibility;
  }
  h1 { font-size: 1.25em; font-weight: 600; margin: 0 0 0.7em; color: ${theme.muted}; letter-spacing: 0.02em; }
  p { margin: 0 0 1.05em; orphans: 2; widows: 2; }
  mark.hl { background: ${theme.mark}; color: inherit; border-radius: 2px; padding: 0 1px; }
  mark.hl-gold { background: ${theme.mark}; }
  mark.hl-moss { background: rgba(47,93,80,0.22); }
  mark.hl-rose { background: rgba(180,85,45,0.20); }
  hr { border: none; border-top: 1px solid ${theme.rule}; margin: 1.4em 0; }
  ::selection { background: rgba(47,93,80,0.25); }
  .end { color: ${theme.muted}; font-size: 0.8em; text-align: center; margin-top: 2em; letter-spacing: 0.08em; }
</style>
</head>
<body>
<h1>${escapeHtml(input.sectionTitle)}</h1>
${body}
<div class="end">— end of section —</div>
<script>
  (function () {
    var lastPct = -1;
    function post(payload) {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
    function paragraphOf(node) {
      while (node && node !== document.body) {
        if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-p')) return node;
        node = node.parentNode;
      }
      return null;
    }
    function offsetWithin(paragraph, node, offset) {
      try {
        var range = document.createRange();
        range.selectNodeContents(paragraph);
        range.setEnd(node, offset);
        return range.toString().length;
      } catch (e) { return 0; }
    }
    var touchTimer = null;
    document.addEventListener('selectionchange', function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      clearTimeout(touchTimer);
      touchTimer = setTimeout(function () {
        var range = sel.getRangeAt(0);
        var p = paragraphOf(range.startContainer);
        if (!p) return;
        var paraIndex = Number(p.getAttribute('data-p'));
        var start = offsetWithin(p, range.startContainer, range.startOffset);
        var end = offsetWithin(p, range.endContainer, range.endOffset);
        var text = sel.toString();
        if (end > start && text.trim().length > 1) {
          post({ type: 'selection', para: paraIndex, start: start, end: end, text: text });
        }
      }, 320);
    });
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.tagName === 'MARK' && target.getAttribute('data-id')) {
        post({ type: 'mark', id: target.getAttribute('data-id') });
      }
    });
    function reportScroll() {
      var doc = document.documentElement;
      var max = Math.max(1, doc.scrollHeight - window.innerHeight);
      var pct = Math.min(1, Math.max(0, window.scrollY / max));
      if (Math.abs(pct - lastPct) > 0.01) {
        lastPct = pct;
        post({ type: 'scroll', pct: pct });
      }
    }
    window.addEventListener('scroll', reportScroll, { passive: true });
    window.__jumpTo = function (text) {
      var found = false;
      var ps = document.querySelectorAll('p[data-p]');
      for (var i = 0; i < ps.length; i++) {
        if (ps[i].textContent.toLowerCase().indexOf(String(text).toLowerCase()) !== -1) {
          ps[i].scrollIntoView({ block: 'center' });
          found = true;
          break;
        }
      }
      post({ type: 'jump', found: found });
    };
    window.__scrollToPct = function (pct) {
      var doc = document.documentElement;
      var max = Math.max(0, doc.scrollHeight - window.innerHeight);
      window.scrollTo(0, max * Math.min(1, Math.max(0, pct)));
    };
    setTimeout(function () {
      ${input.initialScroll ? `window.__scrollToPct(${input.initialScroll});` : ''}
      reportScroll();
      post({ type: 'ready' });
    }, 60);
  })();
</script>
</body>
</html>`;
}

/** Locator format persisted per highlight/bookmark. */
export type ReaderLocator = { sectionId: string; para: number; start: number; end: number; quote?: string };

export function encodeLocator(locator: ReaderLocator): string {
  return JSON.stringify(locator);
}

export function decodeLocator(value: string | null | undefined): ReaderLocator | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ReaderLocator;
    if (!parsed || typeof parsed.sectionId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
