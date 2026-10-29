/**
 * OpenAI-compatible chat provider.
 *
 * Works with any endpoint that implements `/chat/completions` (OpenAI, Groq,
 * Together, a local llama.cpp server, an Ollama OpenAI shim, …). The API key is
 * supplied at runtime from SecureStore and is never bundled or logged.
 */

import { ABSTAIN_TEXT, type AiProvider, type AiRequest, type AiResponse } from './types';
import { extractiveProvider } from './extractive';
import type { Citation } from '@/domain/types';
import { truncate } from '@/domain/text';

export type RemoteOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const SYSTEM_PROMPT = `You are Freehaven's study assistant.
Answer ONLY from the numbered sources supplied by the user.
If the sources do not contain the answer, say that you could not find it.
Return a JSON object: {"answer": string, "citations": [{"chunkId": string, "quote": string}]}.
Rules:
- chunkId MUST be one of the ids in the sources.
- quote MUST be a contiguous sentence from that source.
- Prefer 2-4 citations. Never invent a chunkId or a quote.
- Write in plain Markdown, no code fences.`;

export function buildUserPrompt(request: AiRequest): string {
  const sources = request.sources
    .map(
      (s, i) =>
        `[${i + 1}] chunkId=${s.chunkId}${s.page ? ` page=${s.page}` : ''}\n${truncate(s.text, 1800)}`,
    )
    .join('\n\n');
  const taskLine =
    request.task === 'answer'
      ? `Question: ${request.query}`
      : request.task === 'explain'
        ? `Explain this passage for a learner: ${request.query ?? ''}`
        : request.task === 'lesson'
          ? 'Turn these sources into a short structured lesson with a title, key ideas and one practice prompt.'
          : request.task === 'takeaways'
            ? 'List the key takeaways.'
            : `Summarise these sources (${request.length ?? 'medium'} length).`;
  return `${taskLine}\n\nSources:\n${sources}`;
}

export function parseModelJson(raw: string): { answer: string; citations: Citation[] } {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('Model did not return JSON.');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    answer?: unknown;
    citations?: unknown;
  };
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  const citations = Array.isArray(parsed.citations)
    ? parsed.citations
        .filter((c): c is { chunkId: string; quote: string } => {
          return (
            !!c &&
            typeof c === 'object' &&
            typeof (c as { chunkId?: unknown }).chunkId === 'string' &&
            typeof (c as { quote?: unknown }).quote === 'string'
          );
        })
        .map((c) => ({
          chunkId: c.chunkId,
          bookId: '',
          quote: truncate(c.quote, 320),
          page: null,
          sectionTitle: null,
        }))
    : [];
  return { answer, citations };
}

export function filterValidCitations(
  citations: Citation[],
  sources: AiRequest['sources'],
): Citation[] {
  const allowed = new Map(sources.map((s) => [s.chunkId, s]));
  return citations.filter((c) => allowed.has(c.chunkId) && c.quote.trim().length > 8);
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = 'openai-compatible';
  readonly label = 'Remote model';

  constructor(private options: RemoteOptions) {}

  async isAvailable(): Promise<boolean> {
    return !!this.options.apiKey && !!this.options.baseUrl && !!this.options.model;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    if (!(await this.isAvailable())) throw new Error('Remote provider is not configured.');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 45_000);
    try {
      const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(request) },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`Model endpoint returned ${response.status}.`);
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error('Model returned an empty response.');
      const parsed = parseModelJson(content);
      const citations = filterValidCitations(parsed.citations, request.sources);
      if (!parsed.answer) throw new Error('Model returned no answer.');

      // A grounded answer with zero verifiable citations is downgraded to the
      // extractive path so the user still gets evidence-backed text.
      if (citations.length === 0 && request.task !== 'summary' && request.task !== 'lesson') {
        const fallback = await extractiveProvider.generate(request);
        return { ...fallback, degraded: true };
      }

      return {
        text: parsed.answer,
        citations,
        provider: this.id,
        model: this.options.model,
      };
    } catch (error) {
      const fallback = await extractiveProvider.generate(request);
      return {
        ...fallback,
        degraded: true,
        text: `${fallback.text}\n\n_Remote model unavailable (${(error as Error).message}). Showing an on-device extract instead._`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export { ABSTAIN_TEXT };
