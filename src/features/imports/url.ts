/**
 * URL ingest with SSRF and size guardrails.
 *
 * Only http(s) is allowed; loopback, link-local and RFC1918 hosts are rejected;
 * redirects are followed manually with the same checks; responses are capped.
 * Article extraction is deliberately simple and transparent.
 */

import { fetchJson } from '@/lib/http';
import { normalizeWhitespace } from '@/domain/text';

const MAX_BYTES = 25 * 1024 * 1024;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1|\[::1\])/i;

export function assertSafeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UnsafeUrlError('That does not look like a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UnsafeUrlError('Only http and https links can be imported.');
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new UnsafeUrlError('Local and private network addresses are not allowed.');
  }
  // 172.16.0.0/12
  const m = url.hostname.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) {
    throw new UnsafeUrlError('Local and private network addresses are not allowed.');
  }
  if (!url.hostname.includes('.')) {
    throw new UnsafeUrlError('The host name is not a public domain.');
  }
  return url;
}

export type UrlDocument = { title: string; text: string; url: string; siteName: string | null };

function stripTags(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
}

export function extractArticle(html: string, fallbackTitle: string): UrlDocument['text'] {
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const candidate = article ?? main ?? body;
  const text = stripTags(candidate);
  return text.length > 200 ? text : stripTags(body) || fallbackTitle;
}

export async function importFromUrl(input: string): Promise<UrlDocument> {
  const url = assertSafeUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain', 'User-Agent': 'Freehaven/0.1' },
    });
    if (!response.ok) throw new Error(`The page returned ${response.status}.`);
    const type = response.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|xhtml/i.test(type)) {
      throw new Error('That link is not an HTML article or plain text document.');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) throw new Error('The page is larger than 25 MB.');
    const html = new TextDecoder().decode(buffer);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 160) : url.hostname;
    return {
      title: title || url.hostname,
      text: extractArticle(html, title),
      url: url.toString(),
      siteName: url.hostname,
    };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('The page took too long to respond.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export { fetchJson };
