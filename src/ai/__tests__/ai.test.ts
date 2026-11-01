import * as SecureStore from 'expo-secure-store';
import { extractiveProvider, extractiveToBudget } from '@/ai/extractive';
import { ABSTAIN_TEXT, type AiRequest } from '@/ai/types';
import { wordCount } from '@/domain/text';
import {
  OpenAiCompatibleProvider,
  buildRequestHeaders,
  buildUserPrompt,
  filterValidCitations,
  parseModelJson,
} from '@/ai/remote';
import { getPreset, type ProviderPreset } from '@/ai/presets';
import { currentProviderLabel, resolveProvider } from '@/ai';
import { usePreferences } from '@/state/preferences';

const sources: AiRequest['sources'] = [
  {
    chunkId: 'c1',
    text: 'Compound interest is the addition of interest to the principal sum of a loan or deposit. It is the result of reinvesting interest rather than paying it out.',
    page: 4,
  },
  {
    chunkId: 'c2',
    text: 'Spaced repetition strengthens long-term memory by reviewing material at increasing intervals.',
    page: 9,
  },
];

const answerRequest: AiRequest = { task: 'answer', query: 'What is compound interest?', sources };

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },
  } as unknown as Response;
}

function errorResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Response;
}

function chatResponse(content: string, finishReason = 'stop'): Response {
  return jsonResponse({
    choices: [{ message: { content }, finish_reason: finishReason }],
  });
}

describe('extractive provider', () => {
  it('answers with a citation drawn from the source', async () => {
    const response = await extractiveProvider.generate(answerRequest);
    expect(response.provider).toBe('extractive');
    expect(response.citations.length).toBeGreaterThan(0);
    const ids = new Set(sources.map((s) => s.chunkId));
    for (const citation of response.citations) expect(ids.has(citation.chunkId)).toBe(true);
    expect(response.text.toLowerCase()).toContain('interest');
  });

  it('abstains when the sources do not cover the question', async () => {
    const response = await extractiveProvider.generate({
      ...answerRequest,
      query: 'quantum chromodynamics lattice spacing',
    });
    expect(response.text).toBe(ABSTAIN_TEXT);
    expect(response.citations).toHaveLength(0);
  });

  it('produces a structured lesson with a practice prompt', async () => {
    const response = await extractiveProvider.generate({ task: 'lesson', sources });
    expect(response.text).toContain('### Key ideas');
    expect(response.text).toContain('### Practice');
    expect(response.citations.length).toBeGreaterThan(0);
  });
});

describe('extractive provider — notes, outline and script', () => {
  const longText = Array.from(
    { length: 60 },
    (_, index) =>
      `Passage ${index + 1} explains how compound interest grows the principal through reinvested interest over time.`,
  ).join(' ');

  it('renders notes as [chunkId] sentence lines', async () => {
    const response = await extractiveProvider.generate({ task: 'notes', sources });
    const lines = response.text.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(8);
    for (const line of lines) expect(line).toMatch(/^\[c[12]\] /);
    expect(response.provider).toBe('extractive');
  });

  it('groups an outline under three headings', async () => {
    const titled: AiRequest['sources'] = [
      { chunkId: 'c1', text: sources[0].text, sectionTitle: 'Alpha' },
      { chunkId: 'c2', text: sources[1].text, sectionTitle: 'Beta' },
      { chunkId: 'c3', text: longText, sectionTitle: 'Gamma' },
    ];
    const response = await extractiveProvider.generate({ task: 'outline', sources: titled });
    expect(response.text).toContain('## Alpha');
    expect(response.text).toContain('## Beta');
    expect(response.text).toContain('## Gamma');
    expect(response.text.match(/^## /gm)).toHaveLength(3);
    expect(response.text).toMatch(/^- /m);
  });

  it('falls back to Part headings without section titles', async () => {
    const response = await extractiveProvider.generate({ task: 'outline', sources });
    expect(response.text).toContain('## Part 1');
    expect(response.text).toContain('## Part 3');
  });

  it('writes a script within 90% of the target word budget', async () => {
    const response = await extractiveProvider.generate({
      task: 'script',
      sources: [{ chunkId: 'cS', text: longText }],
      targetWords: 200,
    });
    expect(response.provider).toBe('extractive');
    expect(response.degraded).toBe(true);
    expect(wordCount(response.text)).toBeGreaterThanOrEqual(180);
    expect(response.truncated).toBe(false);
  });

  it('marks a script truncated when the source cannot fill the budget', async () => {
    const response = await extractiveProvider.generate({
      task: 'script',
      sources: [{ chunkId: 'cS', text: 'One short sentence about interest.' }],
      targetWords: 1_000,
    });
    expect(response.truncated).toBe(true);
  });

  it('extractiveToBudget keeps source order and stops near the goal', () => {
    const text = extractiveToBudget(longText, 200);
    expect(wordCount(text)).toBeGreaterThanOrEqual(180);
    const first = text.split('\n\n')[0];
    expect(first).toContain('Passage');
    expect(extractiveToBudget('', 100)).toBe('');
  });
});

describe('remote provider', () => {
  const noSleep = jest.fn(async (_ms: number) => undefined);

  beforeEach(() => {
    noSleep.mockClear();
  });

  it('parses fenced JSON and filters citations to retrieved chunks', () => {
    const raw = '```json\n{"answer":"It grows.","citations":[{"chunkId":"c1","quote":"Compound interest is the addition of interest"},{"chunkId":"ghost","quote":"made up"}]}\n```';
    const parsed = parseModelJson(raw);
    expect(parsed.answer).toBe('It grows.');
    const valid = filterValidCitations(parsed.citations, sources);
    expect(valid).toHaveLength(1);
    expect(valid[0].chunkId).toBe('c1');
  });

  it('builds a prompt that numbers sources and asks for JSON', () => {
    const prompt = buildUserPrompt(answerRequest);
    expect(prompt).toContain('chunkId=c1');
    expect(prompt).toContain('What is compound interest?');
  });

  it('builds task-specific prompts for notes and scripts', () => {
    const notes = buildUserPrompt({ task: 'notes', sources });
    expect(notes).toContain('Prefix every note with the chunk id');
    const script = buildUserPrompt({ task: 'script', sources, targetWords: 250, instruction: 'Warm.' });
    expect(script).toContain('250 words');
    expect(script).toContain('Additional instruction: Warm.');
  });

  it('returns model text with verified citations on success', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: async () =>
        chatResponse(
          JSON.stringify({
            answer: 'Compound interest is interest on interest.',
            citations: [{ chunkId: 'c1', quote: 'Compound interest is the addition of interest' }],
          }),
        ),
    });
    const response = await provider.generate(answerRequest);
    expect(response.provider).toBe('openai-compatible');
    expect(response.degraded).toBeFalsy();
    expect(response.citations[0].chunkId).toBe('c1');
  });

  it('retries a 429 and succeeds on the second attempt', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(errorResponse(429, 'slow down', { 'retry-after': '1' }))
      .mockResolvedValueOnce(
        chatResponse(
          JSON.stringify({
            answer: 'Compound interest is the addition of interest to principal.',
            citations: [{ chunkId: 'c1', quote: 'Compound interest is the addition of interest' }],
          }),
        ),
      );
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate(answerRequest);
    expect(response.text).toContain('Compound interest');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledTimes(1);
    expect(noSleep.mock.calls[0][0]).toBeLessThanOrEqual(8_000);
  });

  it('downgrades on a response_format failure and learns the working rung', async () => {
    const stores: Record<string, string> = {};
    const store = {
      get: jest.fn(async (key: string) => stores[key] ?? null),
      set: jest.fn(async (key: string, value: string) => {
        stores[key] = value;
      }),
    };
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return errorResponse(400, 'response_format is not supported for this model');
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return chatResponse(
          JSON.stringify({
            answer: 'Compound interest is interest on interest.',
            citations: [{ chunkId: 'c1', quote: 'Compound interest is the addition of interest' }],
          }),
        );
      });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'secret',
      presetId: 'groq',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      keyValueStore: store,
    });
    const response = await provider.generate(answerRequest);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
    expect(bodies[1]).not.toHaveProperty('response_format');
    expect(response.strategy).toBe('prompt_only');
    expect(store.set).toHaveBeenCalled();
    const learned = Object.values(stores)[0];
    expect(learned).toContain('prompt_only');
  });

  it('treats a rejected key as fatal and names the preset', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(errorResponse(401, 'bad key'));
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'secret',
      presetId: 'groq',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate(answerRequest);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.degraded).toBe(true);
    expect(response.provider).toBe('extractive');
    expect(response.text).toContain('Groq');
    expect(response.text).toContain('key');
  });

  it('keeps valid JSON that was cut off by the length limit and marks it truncated', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: async () =>
        chatResponse(
          JSON.stringify({
            answer: 'Compound interest is the addition of interest to principal.',
            citations: [{ chunkId: 'c1', quote: 'Compound interest is the addition of interest' }],
          }),
          'length',
        ),
    });
    const response = await provider.generate(answerRequest);
    expect(response.truncated).toBe(true);
    expect(response.text).toContain('Compound interest');
  });

  it('joins an array of text parts without throwing', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: 'Part one.' },
                  { type: 'text', text: ' Part two.' },
                ],
              },
              finish_reason: 'stop',
            },
          ],
        }),
    });
    const response = await provider.generate({ task: 'summary', sources });
    expect(response.text).toContain('Part one. Part two.');
  });

  it('repairs a fabricated quote when the chunk id is real', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: async () =>
        chatResponse(
          JSON.stringify({
            answer: 'Compound interest compounds.',
            citations: [
              { chunkId: 'c1', quote: 'this sentence is completely made up and is nowhere in the passage' },
            ],
          }),
        ),
    });
    const response = await provider.generate(answerRequest);
    expect(response.degraded).toBeFalsy();
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0].quote).not.toContain('completely made up');
    expect(sources[0].text).toContain(
      response.citations[0].quote.replace(/[“”]/g, '').split(' ').slice(0, 5).join(' '),
    );
  });

  it('downgrades to the extractive path when every citation is fabricated', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: async () =>
        chatResponse(
          JSON.stringify({
            answer: 'Invented claim.',
            citations: [{ chunkId: 'does-not-exist', quote: 'nope' }],
          }),
        ),
    });
    const response = await provider.generate(answerRequest);
    expect(response.degraded).toBe(true);
    expect(response.provider).toBe('extractive');
    expect(response.text).not.toBe('Invented claim.');
  });

  it('degrades a summary without leaking the transport note into the text', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate({ task: 'summary', sources });
    expect(response.degraded).toBe(true);
    expect(response.provider).toBe('extractive');
    expect(response.text).not.toMatch(/Remote model unavailable/);
    expect(response.text).not.toMatch(/on-device extract/i);
    expect(response.text.toLowerCase()).toContain('interest');
  });

  it('retries an empty model response once in prompt-only mode', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(chatResponse(''))
      .mockResolvedValueOnce(chatResponse('Compound interest is interest on interest.'));
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      presetId: 'openai',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate({ task: 'summary', sources });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.degraded).toBeFalsy();
    expect(response.strategy).toBe('prompt_only');
    expect(response.text).toContain('Compound interest');
  });

  it('retries an empty json_schema body with prompt_only and uses the plain text', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return chatResponse('');
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return chatResponse('Compound interest grows through reinvested interest.');
      });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'secret',
      presetId: 'openai',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate({ task: 'summary', sources });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.degraded).toBeFalsy();
    expect(response.strategy).toBe('prompt_only');
    expect(response.text).toContain('Compound interest');
    expect(bodies[0].response_format).toEqual({
      type: 'json_schema',
      json_schema: expect.objectContaining({ name: 'grounded_answer', strict: true }),
    });
    expect(bodies[1]).not.toHaveProperty('response_format');
  });

  it('retries an empty json_object body with prompt_only and uses the plain text', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return chatResponse('');
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return chatResponse('Compound interest grows through reinvested interest.');
      });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'secret',
      presetId: 'groq',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate({ task: 'summary', sources });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.degraded).toBeFalsy();
    expect(response.strategy).toBe('prompt_only');
    expect(response.text).toContain('Compound interest');
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
    expect(bodies[1]).not.toHaveProperty('response_format');
  });

  it('retries a JSON body that normalises to nothing with prompt_only', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(chatResponse('{"answer":""}'))
      .mockResolvedValueOnce(chatResponse('Compound interest grows through reinvested interest.'));
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'secret',
      presetId: 'groq',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate({ task: 'summary', sources });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.degraded).toBeFalsy();
    expect(response.strategy).toBe('prompt_only');
    expect(response.text).toContain('Compound interest');
  });

  it('changes only response_format when retrying a JSON body in prompt-only mode', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return chatResponse('');
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return chatResponse('Compound interest grows through reinvested interest.');
      });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'secret',
      presetId: 'openai',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await provider.generate({ task: 'summary', sources, maxOutputTokens: 1_234 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].response_format).toBeUndefined();
    expect(bodies[1].model).toBe(bodies[0].model);
    expect(bodies[1].max_tokens).toBe(bodies[0].max_tokens);
    expect(bodies[1].messages).toEqual(bodies[0].messages);
  });

  it('degrades after two empty prompt_only attempts without looping', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(chatResponse(''));
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'http://192.168.1.10:11434/v1',
      model: 'llama3.2',
      apiKey: '',
      presetId: 'ollama',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate({ task: 'summary', sources });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.degraded).toBe(true);
    expect(response.provider).toBe('extractive');
    expect(response.text.toLowerCase()).toContain('interest');
  });

  it('uses the first attempt when a JSON response is usable', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      chatResponse(
        JSON.stringify({
          answer: 'Compound interest is interest on interest.',
          citations: [{ chunkId: 'c1', quote: 'Compound interest is the addition of interest' }],
        }),
      ),
    );
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'secret',
      presetId: 'openai',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate(answerRequest);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.degraded).toBeFalsy();
    expect(response.strategy).toBe('json_schema');
    expect(response.citations[0].chunkId).toBe('c1');
  });

  it('falls back on network failure and surfaces the reason', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate(answerRequest);
    expect(response.degraded).toBe(true);
    expect(response.text).toMatch(/Remote model unavailable/);
    expect(response.text).toContain('interest');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('falls back after an aborted timeout without an unhandled rejection', async () => {
    const fetchImpl = jest.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate(answerRequest);
    expect(response.degraded).toBe(true);
    expect(response.text).toContain('timed out');
  });

  it('sends the OpenCode Go preset headers on every attempt', async () => {
    const requestHeaders: Record<string, string>[] = [];
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requestHeaders.push(init.headers as Record<string, string>);
        return errorResponse(429, 'slow down');
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requestHeaders.push(init.headers as Record<string, string>);
        return chatResponse('Compound interest is interest on interest.');
      });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      model: 'deepseek-v4.1-flash',
      apiKey: 'secret',
      presetId: 'opencode-go',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const response = await provider.generate({ task: 'summary', sources });
    expect(response.degraded).toBeFalsy();
    expect(requestHeaders).toHaveLength(2);
    for (const headers of requestHeaders) {
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Authorization).toBe('Bearer secret');
      expect(headers['User-Agent']).toBe('Freehaven/1.0');
      expect(headers['x-opencode-session']).toMatch(/^freehaven-/);
    }
  });

  it('never lets a preset header override the transport headers it owns', () => {
    const preset: ProviderPreset = {
      ...getPreset('openrouter'),
      headers: {
        Authorization: 'Bearer not-the-real-key',
        'content-type': 'text/plain',
        'X-Custom': 'yes',
      },
    };
    const headers = buildRequestHeaders(preset, 'real-key');
    expect(headers.Authorization).toBe('Bearer real-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Custom']).toBe('yes');
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === 'authorization')).toHaveLength(
      1,
    );
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === 'content-type')).toHaveLength(
      1,
    );

    const keyless = buildRequestHeaders(preset, '');
    expect(keyless).not.toHaveProperty('Authorization');
  });

  it('keeps the previous header set for presets without headers', async () => {
    let sent: Record<string, string> | null = null;
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      sent = init.headers as Record<string, string>;
      return chatResponse('Compound interest is interest on interest.');
    });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'secret',
      presetId: 'groq',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await provider.generate({ task: 'summary', sources });
    expect(sent).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
    });
    expect(Object.keys(sent ?? {})).toEqual(['Content-Type', 'Authorization']);
  });

  it('is unavailable without a key', async () => {
    const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://x.test', model: 'm', apiKey: '' });
    expect(await provider.isAvailable()).toBe(false);
  });

  it('is available for a keyless LAN preset', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'http://192.168.1.10:11434/v1',
      model: 'llama3.2',
      apiKey: '',
      presetId: 'ollama',
    });
    expect(await provider.isAvailable()).toBe(true);
  });
});

describe('resolveProvider', () => {
  beforeEach(() => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(null);
    usePreferences.setState({ aiProvider: 'local' });
  });

  it('uses a keyless preset when base URL and model are set', async () => {
    usePreferences.setState({
      aiProvider: 'openai-compatible',
      aiPreset: 'ollama',
      aiBaseUrl: 'http://192.168.1.10:11434/v1',
      aiModel: 'llama3.2',
      aiResponseFormat: 'auto',
    });
    const provider = await resolveProvider();
    expect(provider.id).toBe('openai-compatible');
    expect(await provider.isAvailable()).toBe(true);
    expect(await currentProviderLabel()).toBe('Ollama (LAN) · llama3.2');
  });

  it('falls back to extractive when a hosted preset has no key', async () => {
    usePreferences.setState({
      aiProvider: 'openai-compatible',
      aiPreset: 'openrouter',
      aiBaseUrl: 'https://openrouter.ai/api/v1',
      aiModel: 'google/gemma-4-31b-it:free',
    });
    expect((await resolveProvider()).id).toBe('extractive');
    expect(await currentProviderLabel()).toBe('On-device extractive');
  });
});
