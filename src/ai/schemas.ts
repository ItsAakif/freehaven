/**
 * JSON schemas sent as `response_format: {type:'json_schema', …}`.
 *
 * Plain data, one shape per task. `strict: true` requires every object to list
 * all of its properties in `required` and to set `additionalProperties: false`.
 * Do not add `minItems`/`maxLength`: some validators reject unsupported keywords.
 */

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'citations'],
  properties: {
    answer: { type: 'string' },
    citations: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chunkId', 'quote'],
        properties: { chunkId: { type: 'string' }, quote: { type: 'string' } },
      },
    },
  },
} as const;

export const NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notes'],
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'chunkIds'],
        properties: {
          text: { type: 'string' },
          chunkIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export const OUTLINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outline'],
  properties: {
    outline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'points', 'chunkIds'],
        properties: {
          heading: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } },
          chunkIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export const SCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['script', 'usedChunkIds'],
  properties: {
    script: { type: 'string' },
    usedChunkIds: { type: 'array', items: { type: 'string' } },
  },
} as const;

export type JsonSchema = typeof ANSWER_SCHEMA | typeof NOTES_SCHEMA | typeof OUTLINE_SCHEMA | typeof SCRIPT_SCHEMA;
