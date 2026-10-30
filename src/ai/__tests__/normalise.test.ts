import { normaliseModelPayload } from '@/ai/normalise';

const opts = { strategy: 'json_object' as const };

describe('normaliseModelPayload', () => {
  it('parses fenced and prose-wrapped JSON', () => {
    const fenced = normaliseModelPayload('```json\n{"answer":"Hi"}\n```', opts);
    expect(fenced.text).toBe('Hi');
    expect(fenced.shape).toBe('json_object');

    const prose = normaliseModelPayload('Sure thing: {"answer":"Hi"} — done.', opts);
    expect(prose.text).toBe('Hi');
    expect(prose.shape).toBe('fenced_json');
  });

  it('accepts every text alias', () => {
    for (const alias of [
      'answer',
      'summary',
      'text',
      'content',
      'output',
      'result',
      'response',
      'script',
      'takeaways',
      'notes',
    ]) {
      const output = normaliseModelPayload(JSON.stringify({ [alias]: 'Body' }), opts);
      expect(output.text).toBe('Body');
    }
  });

  it('strips a leading Answer: label', () => {
    expect(normaliseModelPayload('{"answer":"Answer: the point"}', opts).text).toBe('the point');
  });

  it('flattens arrays of strings and objects', () => {
    expect(normaliseModelPayload('{"answer":["a","b"]}', opts).text).toBe('a\n\nb');
    expect(normaliseModelPayload('{"notes":[{"text":"n1"},{"text":"n2"}]}', opts).text).toBe(
      'n1\nn2',
    );
    expect(normaliseModelPayload('{"summary":{"parts":["a","b"]}}', opts).text).toBe('a\n\nb');
  });

  it('joins a bare top-level string array as takeaways when asked', () => {
    expect(
      normaliseModelPayload('["x","y"]', { strategy: 'json_object', task: 'takeaways' }).text,
    ).toBe('- x\n- y');
    expect(normaliseModelPayload('["x","y"]', { strategy: 'json_object' }).text).toBe('x\n\ny');
  });

  it('extracts citations from every alias and shape', () => {
    const single = normaliseModelPayload(
      '{"citations":{"chunkId":"c1","quote":"q"}}',
      opts,
    );
    expect(single.citations).toHaveLength(1);
    expect(single.citations[0]).toMatchObject({ chunkId: 'c1', quote: 'q' });

    const aliased = normaliseModelPayload(
      '{"answer":"a","evidence":[{"chunk_id":"c2","snippet":"s"},{"sourceId":"c3","text":"t"}]}',
      opts,
    );
    expect(aliased.citations.map((citation) => citation.chunkId)).toEqual(['c2', 'c3']);

    const bare = normaliseModelPayload(
      '{"answer":"a","sources":["c4 — a quoted line"]}',
      opts,
    );
    expect(bare.citations[0]).toMatchObject({ chunkId: 'c4', quote: 'a quoted line' });
  });

  it('ignores malformed citations but keeps the answer', () => {
    const output = normaliseModelPayload(
      '{"answer":"kept","citations":[{"quote":"no id"},"cannot parse",null]}',
      opts,
    );
    expect(output.text).toBe('kept');
    expect(output.citations).toHaveLength(0);
  });

  it('strips control characters and caps quotes', () => {
    const quote = 'q'.repeat(400);
    const output = normaliseModelPayload(
      JSON.stringify({ answer: 'a\u0000b', citations: [{ chunkId: 'c1', quote }] }),
      opts,
    );
    expect(output.text).toBe('ab');
    expect(output.citations[0].quote).toHaveLength(320);
  });

  it('marks truncation from the finish reason', () => {
    expect(
      normaliseModelPayload('{"answer":"partial"', { strategy: 'json_object', finishReason: 'length' })
        .truncated,
    ).toBe(true);
  });

  it('returns prose when the payload is not JSON', () => {
    const output = normaliseModelPayload('not json at all', { strategy: 'prompt_only' });
    expect(output.text).toBe('not json at all');
    expect(output.shape).toBe('prose');
  });

  it('returns shape empty for an empty payload', () => {
    expect(normaliseModelPayload('', opts)).toMatchObject({ text: '', shape: 'empty' });
  });

  it('never throws for degenerate payloads', () => {
    for (const raw of ['', 'null', '[]', '{"answer":null}', 'not json at all']) {
      expect(() => normaliseModelPayload(raw, opts)).not.toThrow();
    }
    expect(normaliseModelPayload('{"answer":null}', opts).text).toBe('');
    expect(normaliseModelPayload('[]', opts).shape).toBe('empty');
  });
});
