/**
 * OpenAI-compatible chat provider.
 *
 * Works with any endpoint that implements `/chat/completions` (OpenAI, Groq,
 * Together, a local llama.cpp server, an Ollama OpenAI shim, …). The API key is
 * supplied at runtime from SecureStore and is never bundled or logged.
 *
 * The transport is a deterministic strategy ladder: every request starts at the
 * strongest response format the preset claims to support, then downgrades on a
 * classified HTTP failure. Retries are bounded and the learned downgrade is
 * persisted per `(baseUrl, model)`. All side effects (fetch, sleep, storage) are
 * injectable so the whole policy is testable without network or real timers.
 */

import { ABSTAIN_TEXT, AiUnavailableError, type AiProvider, type AiRequest, type AiResponse } from './types';
import { extractiveProvider } from './extractive';
import { verifyCitations } from './citations';
import { normaliseModelPayload } from './normalise';
import {
  ANSWER_SCHEMA,
  NOTES_SCHEMA,
  OUTLINE_SCHEMA,
  SCRIPT_SCHEMA,
  type JsonSchema,
} from './schemas';
import {
  backoffMs,
  classifyHttpFailure,
  planRequest,
  repairJson,
  type ChatMessage,
} from './planner';
import {
  getPreset,
  inferPresetId,
  resolveCapabilities,
  type ProviderPreset,
  type ResponseStrategy,
} from './presets';
import type { Citation } from '@/domain/types';
import { truncate } from '@/domain/text';

export type KeyValueStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

export type RemoteOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Default: inferPresetId(baseUrl). */
  presetId?: string;
  responseFormat?: ResponseStrategy | 'auto';
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; waitMs: number; status?: number }) => void;
  keyValueStore?: KeyValueStore;
};

const MAX_ATTEMPTS = 3;
const MAX_CALL_MS = 120_000;
const MAX_DOWNGRADES = 2;

const GROUNDED_SYSTEM_PROMPT = `You are Freehaven's study assistant.
Answer ONLY from the sources supplied by the user.
If the sources do not contain the answer, say that you could not find it.
Return a JSON object: {"answer": string, "citations": [{"chunkId": string, "quote": string}]}.
Rules:
- chunkId MUST be one of the ids in the sources.
- quote MUST be a contiguous sentence from that source.
- Prefer 2-4 citations. Never invent a chunkId or a quote.
- Write in plain Markdown, no code fences.`;

const NOTES_SYSTEM_PROMPT = `You extract factual notes from the passages supplied by the user.
Return only the notes, one per line, each starting with the source chunk id in brackets.
Rules:
- 4-7 notes, 1-2 sentences each.
- Every note must be supported by a supplied passage.
- Keep names, numbers and technical terms exactly.
- Do not invent material.`;

const OUTLINE_SYSTEM_PROMPT = `You merge factual notes into a single outline.
Return Markdown with 4-6 headings in the order the book develops, each followed by 2-5 bullet points.
Rules:
- Use only the supplied notes.
- Do not invent material that is not in the notes.
- Every bullet must be traceable to a note.`;

const SCRIPT_SYSTEM_PROMPT = `You write grounded prose from factual notes.
Rules:
- Use only the supplied notes.
- Do not add facts, statistics or quotations that are not in the notes.
- Plain Markdown: no preamble, no closing summary, no headings beyond the supplied one.
- Hit the requested word budget as closely as possible.`;

const JSON_RUNG_SUFFIX = ' Return only the JSON object described. No prose, no code fences.';
const PROMPT_ONLY_SUFFIX =
  ' Return a single JSON object with keys `answer` and `citations` when the task asks for an answer. If you cannot produce JSON, answer in plain Markdown and omit citations.';

function taskSystemPrompt(request: AiRequest): string {
  switch (request.task) {
    case 'notes':
      return NOTES_SYSTEM_PROMPT;
    case 'outline':
      return OUTLINE_SYSTEM_PROMPT;
    case 'script':
      return SCRIPT_SYSTEM_PROMPT;
    default:
      return GROUNDED_SYSTEM_PROMPT;
  }
}

export function buildSystemPrompt(request: AiRequest, strategy: ResponseStrategy): string {
  const base = taskSystemPrompt(request);
  const suffix = strategy === 'prompt_only' ? PROMPT_ONLY_SUFFIX : JSON_RUNG_SUFFIX;
  return `${base}${suffix}`;
}

function taskLine(request: AiRequest): string {
  switch (request.task) {
    case 'answer':
      return `Question: ${request.query ?? ''}`;
    case 'explain':
      return `Explain this passage for a learner: ${request.query ?? ''}`;
    case 'lesson':
      return 'Turn these sources into a short structured lesson with a title, key ideas and one practice prompt.';
    case 'takeaways':
      return 'List the key takeaways.';
    case 'notes':
      return 'Read the passages. Extract 4-7 factual notes about the argument, mechanism, evidence or narrative turn. Each note is 1-2 sentences and must be supported by a passage. Keep names, numbers and technical terms. Prefix every note with the chunk id in brackets.';
    case 'outline':
      return 'Merge these notes into a single outline. 4-6 headings in the order the book develops. Under each, 2-5 points. Do not invent material that is not in the notes.';
    case 'script': {
      const words = request.targetWords ?? 725;
      const style = request.styleDirective?.trim() || 'clear, grounded';
      return `Write ${words} words (±10%) of ${style} prose using only these notes. Do not add facts, statistics or quotations that are not in the notes. Plain Markdown, no preamble, no closing summary.`;
    }
    default:
      return `Summarise these sources (${request.length ?? 'medium'} length)${request.targetWords ? ` in about ${request.targetWords} words` : ''}.`;
  }
}

export function buildUserPrompt(request: AiRequest): string {
  const sources = request.sources
    .map(
      (s, i) =>
        `[${i + 1}] chunkId=${s.chunkId}${s.page ? ` page=${s.page}` : ''}${
          s.sectionTitle ? ` section=${s.sectionTitle}` : ''
        }\n${truncate(s.text, 1800)}`,
    )
    .join('\n\n');
  const instruction = request.instruction?.trim();
  return `${taskLine(request)}${instruction ? `\n\nAdditional instruction: ${instruction}` : ''}\n\nSources:\n${sources}`;
}

/**
 * Backwards-compatible parser. Kept for call sites that still expect the old
 * `{ answer, citations }` shape; all parsing now lives in `normalise.ts`.
 */
export function parseModelJson(raw: string): { answer: string; citations: Citation[] } {
  const output = normaliseModelPayload(raw, { strategy: 'json_object' });
  return { answer: output.text, citations: output.citations };
}

/** @deprecated Use `verifyCitations(...).kept`. Re-exported for compatibility. */
export { filterValidCitations } from './citations';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/** Support every content shape in spec §4.1; never use `reasoning` as the answer. */
function extractContent(payload: unknown): { content: string; finishReason?: string } {
  if (!isObject(payload)) return { content: '' };
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = isObject(choices[0]) ? choices[0] : null;
  const finishReason =
    choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;

  let content = '';
  if (choice) {
    const message = isObject(choice.message) ? choice.message : null;
    if (message) content = contentToString(message.content);
    if (!content && typeof choice.text === 'string') content = choice.text;
  }
  if (!content && typeof payload.output_text === 'string') content = payload.output_text;
  if (!content && typeof payload.response === 'string') content = payload.response;

  return { content, finishReason };
}

function retryAfterMs(response: Response): number | undefined {
  const headers = (response as { headers?: Headers }).headers;
  if (!headers || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function normaliseStoreKey(baseUrl: string, model: string): string {
  return `freehaven.ai.capability.${baseUrl.replace(/\/+$/, '')}|${model.trim()}`;
}

/** The json_schema rung must describe the shape the task actually asks for. */
function schemaForTask(task: AiRequest['task']): { schema: JsonSchema; name: string } {
  if (task === 'notes') return { schema: NOTES_SCHEMA, name: 'grounded_notes' };
  if (task === 'outline') return { schema: OUTLINE_SCHEMA, name: 'grounded_outline' };
  if (task === 'script') return { schema: SCRIPT_SCHEMA, name: 'grounded_script' };
  return { schema: ANSWER_SCHEMA, name: 'grounded_answer' };
}

const STRATEGIES: readonly ResponseStrategy[] = ['json_schema', 'json_object', 'prompt_only'];

function asStrategy(value: unknown): ResponseStrategy | null {
  return typeof value === 'string' && (STRATEGIES as readonly string[]).includes(value)
    ? (value as ResponseStrategy)
    : null;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = 'openai-compatible';
  readonly label = 'Remote model';

  constructor(private options: RemoteOptions) {}

  private preset(): ProviderPreset {
    return getPreset(this.options.presetId ?? inferPresetId(this.options.baseUrl));
  }

  async isAvailable(): Promise<boolean> {
    const preset = this.preset();
    const configured = !!this.options.baseUrl.trim() && !!this.options.model.trim();
    if (!configured) return false;
    return preset.requiresKey ? !!this.options.apiKey.trim() : true;
  }

  private async keyValueStore(): Promise<KeyValueStore | null> {
    if (this.options.keyValueStore) return this.options.keyValueStore;
    try {
      const mod = await import('expo-sqlite/kv-store');
      const candidate = (mod as { default?: unknown }).default;
      if (
        candidate &&
        typeof (candidate as { getItem?: unknown }).getItem === 'function' &&
        typeof (candidate as { setItem?: unknown }).setItem === 'function'
      ) {
        const store = candidate as {
          getItem(key: string): Promise<string | null>;
          setItem(key: string, value: string): Promise<void>;
        };
        return {
          get: (key) => store.getItem(key),
          set: (key, value) => store.setItem(key, value),
        };
      }
    } catch {
      /* no persistent store available (tests / web) */
    }
    return null;
  }

  private async readLearned(preset: ProviderPreset): Promise<ResponseStrategy | null> {
    const store = await this.keyValueStore();
    if (!store) return null;
    try {
      const raw = await store.get(normaliseStoreKey(this.options.baseUrl, this.options.model));
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isObject(parsed) ? asStrategy(parsed.strategy) : null;
    } catch {
      return null;
    }
  }

  private async writeLearned(strategy: ResponseStrategy): Promise<void> {
    const store = await this.keyValueStore();
    if (!store) return;
    try {
      await store.set(
        normaliseStoreKey(this.options.baseUrl, this.options.model),
        JSON.stringify({ strategy, at: Date.now() }),
      );
    } catch {
      /* learning is best-effort; never fail a request over it */
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms);
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private host(): string {
    try {
      return new URL(this.options.baseUrl).host;
    } catch {
      return 'the provider';
    }
  }

  private failureMessage(status: number, preset: ProviderPreset): string {
    if (status === 401 || status === 403) {
      return `The key was rejected by ${preset.label}. Check it in Settings.`;
    }
    if (status === 402) return 'This provider reports no credits.';
    if (status === 429) return 'Free models are shared. Try another model or wait.';
    if (status === 408 || status === 409 || status === 425) {
      return `The request to ${this.host()} timed out or was rate-limited.`;
    }
    return `The model endpoint returned ${status}.`;
  }

  private networkMessage(error: unknown): string {
    const name =
      error instanceof Error
        ? error.name
        : isObject(error) && typeof error.name === 'string'
          ? error.name
          : '';
    if (name === 'AbortError') return `The request to ${this.host()} timed out.`;
    return `Could not reach ${this.host()}.`;
  }

  private async degraded(request: AiRequest, error: Error): Promise<AiResponse> {
    const fallback = await extractiveProvider.generate(request);
    return {
      ...fallback,
      degraded: true,
      text: `${fallback.text}\n\n_Remote model unavailable (${error.message}). Showing an on-device extract instead._`,
    };
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    if (!(await this.isAvailable())) throw new Error('Remote provider is not configured.');

    const preset = this.preset();
    const learned = await this.readLearned(preset);
    const { strategies, capabilities } = resolveCapabilities(
      preset,
      this.options.responseFormat ?? 'auto',
      learned,
    );

    const userPrompt = buildUserPrompt(request);
    const startedAt = Date.now();
    let strategyIndex = 0;
    let attemptsThisRung = 0;
    let totalHttpAttempts = 0;
    let downgrades = 0;
    let reasked = false;
    let reaskMessages: ChatMessage[] | null = null;
    let reaskMaxTokens: number | undefined;
    let lastError: Error | null = null;

    while (strategyIndex < strategies.length) {
      const strategy = strategies[strategyIndex];
      if (Date.now() - startedAt > MAX_CALL_MS) {
        lastError = new Error(`The request to ${this.host()} exceeded the time budget.`);
        break;
      }

      const baseMessages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(request, strategy) },
        { role: 'user', content: userPrompt },
      ];
      const messages = reaskMessages ?? baseMessages;
      const taskSchema = schemaForTask(request.task);
      const planned = planRequest({
        preset,
        model: this.options.model,
        capability: capabilities,
        strategy,
        messages,
        maxOutputTokens: reaskMaxTokens ?? request.maxOutputTokens,
        temperature: 0.2,
        schema: taskSchema.schema,
        schemaName: taskSchema.name,
      });

      const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? preset.timeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl()(
          `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              ...(this.options.apiKey.trim()
                ? { Authorization: `Bearer ${this.options.apiKey}` }
                : {}),
            },
            body: JSON.stringify(planned.body),
          },
        );
      } catch (error) {
        totalHttpAttempts += 1;
        if (Date.now() - startedAt > MAX_CALL_MS) {
          lastError = new Error(`The request to ${this.host()} exceeded the time budget.`);
          break;
        }
        if (attemptsThisRung < MAX_ATTEMPTS - 1) {
          const waitMs = backoffMs(attemptsThisRung);
          this.options.onRetry?.({ attempt: attemptsThisRung + 1, waitMs });
          await this.sleep(waitMs);
          attemptsThisRung += 1;
          continue;
        }
        lastError = new Error(this.networkMessage(error));
        break;
      } finally {
        clearTimeout(timer);
      }

      totalHttpAttempts += 1;

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const classification = classifyHttpFailure(response.status, bodyText);

        if (classification === 'retry') {
          if (attemptsThisRung < MAX_ATTEMPTS - 1 && Date.now() - startedAt < MAX_CALL_MS) {
            const waitMs = backoffMs(attemptsThisRung, retryAfterMs(response));
            this.options.onRetry?.({
              attempt: attemptsThisRung + 1,
              waitMs,
              status: response.status,
            });
            await this.sleep(waitMs);
            attemptsThisRung += 1;
            continue;
          }
          lastError = new Error(this.failureMessage(response.status, preset));
          break;
        }

        if (classification === 'downgrade' && downgrades < MAX_DOWNGRADES) {
          const nextIndex = strategyIndex + 1;
          const next = nextIndex < strategies.length ? strategies[nextIndex] : null;
          if (next) {
            if (totalHttpAttempts === 1 && attemptsThisRung === 0) {
              await this.writeLearned(next);
            }
            strategyIndex = nextIndex;
            downgrades += 1;
            attemptsThisRung = 0;
            reasked = false;
            reaskMessages = null;
            reaskMaxTokens = undefined;
            continue;
          }
        }

        lastError = new Error(this.failureMessage(response.status, preset));
        break;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const { content, finishReason } = extractContent(payload);
      if (!content.trim()) {
        lastError = new AiUnavailableError('Model returned an empty response.');
        break;
      }

      let output = normaliseModelPayload(content, {
        strategy,
        finishReason,
        task: request.task,
      });

      if (!output.text.trim() && output.truncated) {
        const repaired = repairJson(content);
        if (repaired) {
          const repairedOutput = normaliseModelPayload(repaired, {
            strategy,
            task: request.task,
          });
          output = { ...repairedOutput, truncated: repairedOutput.truncated || output.truncated };
        }
      }

      if (!output.text.trim()) {
        lastError = new AiUnavailableError('Model returned no usable answer.');
        break;
      }

      // Truncated output with no parseable JSON: one smaller re-ask at this rung.
      if (
        output.truncated &&
        (output.shape === 'prose' || output.shape === 'empty') &&
        strategy !== 'prompt_only' &&
        !reasked &&
        attemptsThisRung < MAX_ATTEMPTS - 1
      ) {
        const previousMaxTokens =
          reaskMaxTokens ?? request.maxOutputTokens ?? capabilities.maxOutputTokens;
        const smaller = Math.max(256, Math.floor(previousMaxTokens * 0.6));
        const characters = Math.floor(previousMaxTokens * 0.6 * 4);
        reaskMessages = [
          ...baseMessages,
          {
            role: 'user',
            content: `Return only the JSON object. Keep it under ${characters} characters.`,
          },
        ];
        reaskMaxTokens = smaller;
        reasked = true;
        attemptsThisRung += 1;
        continue;
      }

      const verified = verifyCitations(output.citations, request.sources, {
        query: request.query,
      });

      // Grounded answers need at least one verified citation; everything else
      // (notes, outlines, scripts, summaries) may legitimately be citation-free.
      if (
        (request.task === 'answer' || request.task === 'explain') &&
        verified.kept.length === 0
      ) {
        const fallback = await extractiveProvider.generate(request);
        return { ...fallback, degraded: true };
      }

      return {
        text: output.text,
        citations: verified.kept,
        provider: this.id,
        model: this.options.model,
        strategy,
        truncated: output.truncated,
        usage: {
          promptChars: baseMessages.reduce((sum, message) => sum + message.content.length, 0),
          completionChars: content.length,
        },
      };
    }

    return this.degraded(
      request,
      lastError ?? new AiUnavailableError('Remote provider did not complete the request.'),
    );
  }
}

export { ABSTAIN_TEXT };
