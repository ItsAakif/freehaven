/**
 * Request planning and transport policy.
 *
 * Every function here is pure: no `fetch`, no timers, no random side effects
 * beyond the injected `rand`. `remote.ts` owns the network and uses these rules
 * so a provider failure has exactly one classification.
 */

import { ANSWER_SCHEMA } from './schemas';
import type { JsonSchema } from './schemas';
import type { ProviderCapabilities, ProviderPreset, ResponseStrategy } from './presets';

export interface PlannedRequest {
  strategy: ResponseStrategy;
  /** Exact JSON body for POST {baseUrl}/chat/completions. */
  body: Record<string, unknown>;
  downgradedFrom?: ResponseStrategy;
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type PlannedMessage = ChatMessage;

export function planRequest(input: {
  preset: ProviderPreset;
  model: string;
  capability: ProviderCapabilities;
  strategy: ResponseStrategy;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Task-shaped schema for the json_schema rung; defaults to the grounded answer. */
  schema?: JsonSchema;
  schemaName?: string;
}): PlannedRequest {
  const { preset, model, capability, strategy } = input;
  const body: Record<string, unknown> = {
    model,
    messages: planMessages(input.messages, capability.systemRole),
    temperature: input.temperature ?? 0.2,
    max_tokens: input.maxOutputTokens ?? capability.maxOutputTokens,
  };

  if (strategy === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: input.schemaName ?? 'grounded_answer',
        strict: true,
        schema: input.schema ?? ANSWER_SCHEMA,
      },
    };
  } else if (strategy === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  // Gate on the preset id, not a URL guess: other endpoints can 400 on `provider`.
  if (preset.id === 'openrouter' && strategy !== 'prompt_only') {
    body.provider = { require_parameters: true };
  }

  return { strategy, body };
}

/** Fold system content into the first user turn when a model rejects the role. */
function planMessages(messages: ChatMessage[], systemRole: boolean): PlannedMessage[] {
  if (systemRole) {
    return messages.map((message) => ({ role: message.role, content: message.content }));
  }

  const systemContent = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const rest: PlannedMessage[] = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));

  if (!systemContent) return rest;
  if (!rest.length) return [{ role: 'user', content: systemContent }];
  // Fold into the *first user turn*, wherever it is, so message order and count
  // change by exactly the number of system messages removed.
  const firstUser = rest.findIndex((message) => message.role === 'user');
  if (firstUser === -1) {
    rest.push({ role: 'user', content: systemContent });
  } else {
    rest[firstUser] = {
      role: 'user',
      content: `${systemContent}\n\n${rest[firstUser].content}`,
    };
  }
  return rest;
}

/** json_schema → json_object → prompt_only → null. */
export function nextStrategy(strategy: ResponseStrategy): ResponseStrategy | null {
  if (strategy === 'json_schema') return 'json_object';
  if (strategy === 'json_object') return 'prompt_only';
  return null;
}

const DOWNGRADE_PATTERN =
  /response_format|json_schema|json object|unsupported|not supported|provider/i;

/**
 * Deterministic status policy from the spec table.
 *
 * 400/404/422 → downgrade only when the body blames a feature we can drop;
 * otherwise fatal. Retryable statuses back off. Auth/credit failures are fatal.
 */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
): 'retry' | 'downgrade' | 'fatal' {
  if (status === 400 || status === 404 || status === 422) {
    return DOWNGRADE_PATTERN.test(bodyText ?? '') ? 'downgrade' : 'fatal';
  }
  if (status === 401 || status === 402 || status === 403) return 'fatal';
  if (status === 408 || status === 409 || status === 425) return 'retry';
  if (status === 429) return 'retry';
  if (status === 500 || status === 502 || status === 503 || status === 504) return 'retry';
  return 'fatal';
}

const MAX_BACKOFF_MS = 8_000;

/** Exponential backoff with jitter, capped at 8 s; `Retry-After` wins when larger. */
export function backoffMs(
  attempt: number,
  retryAfterMs?: number,
  rand: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const base = Math.min(MAX_BACKOFF_MS, Math.round(800 * 2 ** safeAttempt + rand() * 250));
  if (retryAfterMs && retryAfterMs > base) return Math.min(MAX_BACKOFF_MS, retryAfterMs);
  return base;
}

type Scan = { candidate: string; closed: boolean };

/** Scan a balanced `{}`/`[]` block, ignoring braces inside strings and escapes. */
function scanBlock(text: string, start: number): Scan | null {
  const first = text[start];
  if (first !== '{' && first !== '[') return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      const expected = stack.pop();
      if (!expected || expected !== ch) return null;
      if (!stack.length) return { candidate: text.slice(start, i + 1), closed: true };
    }
  }
  return { candidate: text.slice(start), closed: false };
}

/** Remove commas that sit directly before a closing brace/bracket, outside strings. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** Close a dangling string, drop a trailing comma, then close open brackets. */
function closeBlock(candidate: string): string | null {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      const expected = stack.pop();
      if (!expected || expected !== ch) return null;
    }
  }

  let repaired = candidate;
  if (inString) repaired += escaped ? '\\"' : '"';
  repaired = repaired.replace(/,\s*$/, '');
  repaired = stripTrailingCommas(repaired);
  while (stack.length) repaired += stack.pop();
  return stripTrailingCommas(repaired);
}

function tryParse(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort JSON repair: fences, prose wrappers, trailing commas and
 * truncation. Returns a parseable JSON string, or `null` when irreparable.
 * Never throws.
 */
export function repairJson(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();

  if ((text.startsWith('{') || text.startsWith('[')) && tryParse(text)) return text;

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const scan = scanBlock(text, start);
    if (!scan) continue;
    if (scan.closed) {
      const cleaned = stripTrailingCommas(scan.candidate);
      if (tryParse(cleaned)) return cleaned;
      continue;
    }
    const repaired = closeBlock(scan.candidate);
    if (repaired && tryParse(repaired)) return repaired;
  }
  return null;
}

/** True when `finishReason` says truncation, or the JSON payload is unbalanced. */
export function detectTruncation(finishReason: string | undefined, content: string): boolean {
  if (finishReason === 'length' || finishReason === 'max_tokens') return true;
  if (typeof content !== 'string') return false;

  let start = -1;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '{' || content[i] === '[') {
      start = i;
      break;
    }
  }
  if (start === -1) return false;

  const scan = scanBlock(content, start);
  return !scan || !scan.closed;
}
