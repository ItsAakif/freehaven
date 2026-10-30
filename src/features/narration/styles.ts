/**
 * Narration style presets.
 *
 * Style is data, not a prosody flag: every preset changes what the script says
 * and (when the engine supports it) how it is delivered. Pure module: no Expo,
 * no network, safe to import from tests and from the preference migration.
 */

import type { NarrationLength, NarrationStyleId, RenditionEngine } from '@/domain/narration';

export type { NarrationLength, NarrationStyleId, RenditionEngine };

/** @deprecated Import `NarrationStyleId`; kept for older call sites. */
export type NarrationStyle = NarrationStyleId;

export interface NarrationStylePreset {
  id: NarrationStyleId;
  label: string;
  /** One line, shown under the style chip. */
  persona: string;
  /** 1-2 sentences injected into the script prompt and (when supported) TTS instructions. */
  directive: string;
  /** Structural rules the script prompt enforces; also used by tests as expectations. */
  scriptRules: string[];
  /** Where the style lands when the user has not chosen a length. */
  defaultLength: NarrationLength;
  /** Max share of sentences that may be connective/commentary rather than source-grounded. */
  fillerBudget: number;
  /** Device is always null (system default). Other engines use a concrete voice id. */
  defaultVoices: Record<RenditionEngine, string | null>;
  /** Default Kokoro speaker index; clamped to the bundle's voice count at runtime. */
  kokoroSpeakerId: number;
}

export const DEFAULT_STYLE_ID: NarrationStyleId = 'fireside';

export const LEGACY_STYLE_MAP: Record<string, NarrationStyleId> = {
  calm: 'fireside',
  conversational: 'fireside',
  teacher: 'plain',
  dramatic: 'chronicle',
  // defensive extras seen in older builds / hand-edited stores
  neutral: 'fireside',
  summary: 'brief',
};

export const NARRATION_STYLES: readonly NarrationStylePreset[] = [
  {
    id: 'brief',
    label: 'Brief',
    persona: "Everything that matters, nothing that doesn't.",
    directive: 'Speak briskly and evenly. No asides, no rhetorical questions, no recap.',
    scriptRules: [
      'State the thesis in the first 20 words.',
      'Keep the tightest possible chain of claims and evidence; drop anecdotes and repeated points.',
      'Target about 40% fewer words than a plain telling of the same source.',
    ],
    defaultLength: '5',
    fillerBudget: 0.05,
    defaultVoices: { device: null, remote: 'onyx', piper: 'default', kokoro: 'default' },
    kokoroSpeakerId: 3,
  },
  {
    id: 'chronicle',
    label: 'Chronicle',
    persona: 'A story with a spine.',
    directive: 'Warm, forward-moving delivery; let tension build and land the turn.',
    scriptRules: [
      'Arrange the material as a sequence of scenes or turning points in the order it develops: setup, complication, resolution.',
      'People act and things change; re-order and narrate only what the source states.',
      'Never invent scenes, dialogue or characters.',
    ],
    defaultLength: '15',
    fillerBudget: 0.2,
    defaultVoices: { device: null, remote: 'fable', piper: 'default', kokoro: 'default' },
    kokoroSpeakerId: 0,
  },
  {
    id: 'plain',
    label: 'Plain',
    persona: 'Clear enough to explain at a kitchen table.',
    directive: 'Slow, friendly, evenly paced. Pause after each idea.',
    scriptRules: [
      'Keep sentences to 18 words on average; one idea per paragraph.',
      'Define every technical term the first time in plain words.',
      'Use a concrete example from the source; if there is none, explain the idea without inventing one.',
    ],
    defaultLength: '5',
    fillerBudget: 0.2,
    defaultVoices: { device: null, remote: 'nova', piper: 'default', kokoro: 'default' },
    kokoroSpeakerId: 1,
  },
  {
    id: 'mechanism',
    label: 'Mechanism',
    persona: 'Show the machinery, then the evidence.',
    directive: 'Measured, precise, unhurried; slight emphasis on numbers and causal words.',
    scriptRules: [
      'For each claim: how it works, what evidence supports it, what would falsify it, and where the source is uncertain.',
      'Keep sample sizes, effect directions and caveats.',
      'Prefer causal language over moral language.',
    ],
    defaultLength: '15',
    fillerBudget: 0.1,
    defaultVoices: { device: null, remote: 'echo', piper: 'default', kokoro: 'default' },
    kokoroSpeakerId: 2,
  },
  {
    id: 'debate',
    label: 'Debate',
    persona: 'Two cases, honestly made, then a verdict.',
    directive:
      'Two distinct mannerisms: advocate A clipped and confident, advocate B slower and probing.',
    scriptRules: [
      'State the question, give the strongest case for using only source material, then the strongest case against, then what the source settles and leaves open.',
      'Give each side its best evidence; no straw men.',
    ],
    defaultLength: '15',
    fillerBudget: 0.15,
    defaultVoices: { device: null, remote: 'alloy', piper: 'default', kokoro: 'default' },
    kokoroSpeakerId: 4,
  },
  {
    id: 'backstage',
    label: 'Backstage',
    persona: 'What was really going on behind the announcement.',
    directive: 'Low, confiding, slightly conspiratorial; vary pace, drop volume on the reveal.',
    scriptRules: [
      'Frame the story behind the official version: incentives, conflicts, what was omitted, who benefited.',
      'Attribute every dramatic claim to the source; say "the text implies" where it only implies.',
      'Never invent quotes, names or events.',
    ],
    defaultLength: '15',
    fillerBudget: 0.15,
    defaultVoices: { device: null, remote: 'shimmer', piper: 'default', kokoro: 'default' },
    kokoroSpeakerId: 5,
  },
  {
    id: 'fireside',
    label: 'Fireside',
    persona: 'A smart friend talking it through with you.',
    directive:
      'Relaxed, conversational, second person; natural pauses, occasional upward inflection.',
    scriptRules: [
      'Talk to the listener in the second person: "here\'s the part that surprised me", "notice what this assumes".',
      'Asides must comment on source material and add no facts.',
      'Keep connective commentary within the filler budget.',
    ],
    defaultLength: '15',
    fillerBudget: 0.2,
    defaultVoices: { device: null, remote: 'nova', piper: 'default', kokoro: 'default' },
    kokoroSpeakerId: 6,
  },
] as const;

const STYLE_BY_ID = new Map<string, NarrationStylePreset>(
  NARRATION_STYLES.map((style) => [style.id, style]),
);

const FALLBACK_STYLE = STYLE_BY_ID.get(DEFAULT_STYLE_ID) as NarrationStylePreset;

/** Map a stored/legacy value onto a real style id. Never throws. */
export function coerceNarrationStyle(value: unknown): NarrationStyleId {
  if (typeof value !== 'string') return DEFAULT_STYLE_ID;
  const key = value.trim().toLowerCase();
  if (!key) return DEFAULT_STYLE_ID;
  if (STYLE_BY_ID.has(key)) return key as NarrationStyleId;
  return LEGACY_STYLE_MAP[key] ?? DEFAULT_STYLE_ID;
}

/** Look up a preset by id; unknown/legacy/null coerces, then falls back to fireside. */
export function getNarrationStyle(id: string | null | undefined): NarrationStylePreset {
  if (typeof id === 'string') {
    const direct = STYLE_BY_ID.get(id.trim().toLowerCase());
    if (direct) return direct;
  }
  const coerced = STYLE_BY_ID.get(coerceNarrationStyle(id));
  return coerced ?? FALLBACK_STYLE;
}
