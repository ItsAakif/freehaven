import {
  backoffMs,
  classifyHttpFailure,
  detectTruncation,
  nextStrategy,
  planRequest,
  repairJson,
} from '@/ai/planner';
import { getPreset, resolveCapabilities } from '@/ai/presets';
import type { ChatMessage } from '@/ai/planner';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Return JSON.' },
  { role: 'user', content: 'Question? ' },
];

function planFor(presetId: string, strategy: 'json_schema' | 'json_object' | 'prompt_only') {
  const preset = getPreset(presetId);
  return planRequest({
    preset,
    model: preset.defaultModel,
    capability: preset.capabilities,
    strategy,
    messages,
  });
}

describe('planRequest', () => {
  it('emits the response_format for each rung', () => {
    const schema = planFor('openai', 'json_schema');
    expect((schema.body.response_format as { type: string }).type).toBe('json_schema');
    const object = planFor('openai', 'json_object');
    expect((object.body.response_format as { type: string }).type).toBe('json_object');
    const prompt = planFor('openai', 'prompt_only');
    expect(prompt.body).not.toHaveProperty('response_format');
  });

  it('only sends provider routing to OpenRouter JSON rungs', () => {
    expect(planFor('openrouter', 'json_schema').body.provider).toEqual({ require_parameters: true });
    expect(planFor('openrouter', 'json_object').body).toHaveProperty('provider');
    expect(planFor('openrouter', 'prompt_only').body).not.toHaveProperty('provider');
    expect(planFor('openai', 'json_schema').body).not.toHaveProperty('provider');
    expect(planFor('groq', 'json_object').body).not.toHaveProperty('provider');
  });

  it('always sends max_tokens from the override or capabilities', () => {
    const preset = getPreset('groq');
    const planned = planRequest({
      preset,
      model: 'm',
      capability: preset.capabilities,
      strategy: 'json_object',
      messages,
    });
    expect(planned.body.max_tokens).toBe(preset.capabilities.maxOutputTokens);

    const overridden = planRequest({
      preset,
      model: 'm',
      capability: preset.capabilities,
      strategy: 'json_object',
      messages,
      maxOutputTokens: 123,
      temperature: 0.5,
    });
    expect(overridden.body.max_tokens).toBe(123);
    expect(overridden.body.temperature).toBe(0.5);
  });

  it('keeps the system message when the model supports the role', () => {
    const planned = planFor('openai', 'json_object');
    const plannedMessages = planned.body.messages as { role: string; content: string }[];
    expect(plannedMessages).toHaveLength(2);
    expect(plannedMessages[0]).toEqual({ role: 'system', content: 'Return JSON.' });
  });

  it('folds system content into the first user message when systemRole is false', () => {
    const base = getPreset('openai');
    const preset = {
      ...base,
      capabilities: { ...base.capabilities, systemRole: false },
    };
    const planned = planRequest({
      preset,
      model: 'm',
      capability: preset.capabilities,
      strategy: 'prompt_only',
      messages: [
        { role: 'system', content: 'SYS ONE' },
        { role: 'assistant', content: 'assistant text' },
        { role: 'system', content: 'SYS TWO' },
        { role: 'user', content: 'USER' },
      ],
    });
    const plannedMessages = planned.body.messages as { role: string; content: string }[];
    expect(plannedMessages).toHaveLength(2);
    expect(plannedMessages.some((message) => message.role === 'system')).toBe(false);
    expect(plannedMessages[0]).toEqual({
      role: 'assistant',
      content: 'assistant text',
    });
    expect(plannedMessages[1]).toEqual({
      role: 'user',
      content: 'SYS ONE\n\nSYS TWO\n\nUSER',
    });
  });

  it('prepends folded system content to a leading user turn', () => {
    const base = getPreset('openai');
    const preset = { ...base, capabilities: { ...base.capabilities, systemRole: false } };
    const planned = planRequest({
      preset,
      model: 'm',
      capability: preset.capabilities,
      strategy: 'prompt_only',
      messages: [
        { role: 'system', content: 'SYS ONE' },
        { role: 'system', content: 'SYS TWO' },
        { role: 'user', content: 'USER' },
      ],
    });
    const plannedMessages = planned.body.messages as { role: string; content: string }[];
    expect(plannedMessages).toHaveLength(1);
    expect(plannedMessages[0].content).toBe('SYS ONE\n\nSYS TWO\n\nUSER');
  });
});

describe('strategy ladder', () => {
  it('is exhaustive and ends at null', () => {
    expect(nextStrategy('json_schema')).toBe('json_object');
    expect(nextStrategy('json_object')).toBe('prompt_only');
    expect(nextStrategy('prompt_only')).toBeNull();
  });

  it('resolves a concrete ladder for each preset', () => {
    const { strategies } = resolveCapabilities(getPreset('openai'), 'auto', null);
    const walked = [strategies[0]];
    let next = nextStrategy(strategies[0]);
    while (next) {
      walked.push(next);
      next = nextStrategy(next);
    }
    expect(walked).toEqual(strategies);
  });
});

describe('classifyHttpFailure', () => {
  it.each([
    [400, 'response_format is not supported', 'downgrade'],
    [400, 'bad model', 'fatal'],
    [422, 'json_schema rejected', 'downgrade'],
    [404, 'provider missing', 'downgrade'],
    [404, 'not found', 'fatal'],
    [429, 'slow down', 'retry'],
    [401, 'unauthorised', 'fatal'],
    [403, 'forbidden', 'fatal'],
    [402, 'no credits', 'fatal'],
    [500, 'boom', 'retry'],
    [502, 'bad gateway', 'retry'],
    [503, 'unavailable', 'retry'],
    [504, 'timeout', 'retry'],
    [408, 'timeout', 'retry'],
  ] as const)('classifies %i %s', (status, body, expected) => {
    expect(classifyHttpFailure(status, body)).toBe(expected);
  });
});

describe('backoffMs', () => {
  it('grows with the attempt number', () => {
    const values = [0, 1, 2, 3].map((attempt) => backoffMs(attempt, undefined, () => 0));
    expect(values).toEqual([800, 1600, 3200, 6400]);
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThan(values[i - 1]);
  });

  it('honours Retry-After when it is larger', () => {
    expect(backoffMs(0, 5_000, () => 0)).toBe(5_000);
    expect(backoffMs(3, 100, () => 0)).toBe(6400);
  });

  it('never exceeds eight seconds', () => {
    expect(backoffMs(10, undefined, () => 0)).toBeLessThanOrEqual(8_000);
    expect(backoffMs(0, 60_000, () => 0)).toBe(8_000);
  });
});

describe('detectTruncation', () => {
  it('detects finish reasons and unbalanced JSON', () => {
    expect(detectTruncation('length', '…')).toBe(true);
    expect(detectTruncation('max_tokens', 'anything')).toBe(true);
    expect(detectTruncation('stop', '{"a":1}')).toBe(false);
    expect(detectTruncation('stop', '{"a":')).toBe(true);
    expect(detectTruncation('stop', 'plain prose, no json')).toBe(false);
    expect(detectTruncation(undefined, '{"a":"unterminated')).toBe(true);
  });
});

describe('repairJson', () => {
  function parsed(raw: string): unknown {
    const repaired = repairJson(raw);
    expect(repaired).not.toBeNull();
    return JSON.parse(repaired as string);
  }

  it('handles fenced JSON', () => {
    expect(parsed('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('handles prose around JSON', () => {
    expect(parsed('Sure! Here is the object: {"a":1}. Hope it helps.')).toEqual({ a: 1 });
  });

  it('drops a trailing comma', () => {
    expect(parsed('{"a":1,}')).toEqual({ a: 1 });
    expect(parsed('[1,2,]')).toEqual([1, 2]);
  });

  it('closes a truncated nested object', () => {
    expect(parsed('{"a":{"b":[1,2')).toEqual({ a: { b: [1, 2] } });
    expect(parsed('{"a":"hello')).toEqual({ a: 'hello' });
  });

  it('keeps a brace that lives inside a string', () => {
    expect(parsed('{"a":"value with } brace"}')).toEqual({ a: 'value with } brace' });
  });

  it('closes an unbalanced array', () => {
    expect(parsed('[1,2,3')).toEqual([1, 2, 3]);
  });

  it('returns null for irreparable input', () => {
    expect(repairJson('')).toBeNull();
    expect(repairJson('not json at all')).toBeNull();
    expect(repairJson('   ')).toBeNull();
    expect(repairJson('null')).toBeNull();
  });
});
