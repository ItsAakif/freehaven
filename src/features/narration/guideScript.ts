/**
 * Pure parser for a rendition's generated `script_md`. The guide screen and the
 * PDF export share it so both render exactly the same topics and quotes.
 */

export type GuideBlockKind = 'paragraph' | 'quote';

export type GuideBlock = { kind: GuideBlockKind; text: string };

export type GuideTopic = { title: string; blocks: GuideBlock[] };

export type ParsedGuideScript = { intro: GuideBlock[]; topics: GuideTopic[] };

const HEADING = /^##\s+(.+?)\s*#*\s*$/;

function blockFromLines(lines: string[]): GuideBlock | null {
  const cleaned = lines.map((line) => line.trim()).filter(Boolean);
  if (!cleaned.length) return null;
  const quoted = cleaned.every((line) => line.startsWith('>'));
  const text = cleaned
    .map((line) => {
      if (quoted) return line.replace(/^>\s?/, '');
      return line.replace(/^[-*]\s+/, '• ');
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return { kind: quoted ? 'quote' : 'paragraph', text };
}

function blocksFromChunk(chunk: string): GuideBlock[] {
  const blocks: GuideBlock[] = [];
  let current: string[] = [];
  const flush = () => {
    const block = blockFromLines(current);
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of chunk.split('\n')) {
    if (!line.trim()) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Split a script on `## heading` markers. Anything before the first heading is
 * the intro; each heading starts a numbered topic in the guide.
 */
export function parseGuideScript(markdown: string): ParsedGuideScript {
  const normalised = (markdown ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalised) return { intro: [], topics: [] };

  const introLines: string[] = [];
  const topics: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of normalised.split('\n')) {
    const match = HEADING.exec(line);
    if (match) {
      current = { title: match[1].trim(), lines: [] };
      topics.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else introLines.push(line);
  }

  return {
    intro: blocksFromChunk(introLines.join('\n')),
    topics: topics
      .map((topic) => ({ title: topic.title, blocks: blocksFromChunk(topic.lines.join('\n')) }))
      .filter((topic) => topic.title.length > 0),
  };
}
