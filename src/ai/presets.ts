/**
 * Provider preset registry.
 *
 * Pure data and pure functions: no Expo imports, no network. The registry only
 * describes what a provider *claims* to support; the transport layer still
 * downgrades on a classified failure and records what it learned.
 */

export type ResponseStrategy = 'json_schema' | 'json_object' | 'prompt_only';

export interface ProviderCapabilities {
  /** Accepts response_format:{type:'json_schema', json_schema:{…}}. */
  jsonSchema: boolean;
  /** Accepts response_format:{type:'json_object'}. */
  jsonObject: boolean;
  /** Accepts {role:'system'} (false ⇒ fold system into the first user turn). */
  systemRole: boolean;
  /** Conservative prompt budget in characters (not tokens). */
  contextChars: number;
  /** Sent as max_tokens; also bounds expansion. */
  maxOutputTokens: number;
  /** Send provider:{require_parameters:true} (OpenRouter routing). */
  openRouterRouting: boolean;
}

export interface SuggestedModel {
  id: string;
  label: string;
  hint?: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  /** No trailing slash. */
  baseUrl: string;
  defaultModel: string;
  requiresKey: boolean;
  capabilities: ProviderCapabilities;
  /** Per attempt. */
  timeoutMs: number;
  /**
   * Static headers sent with every request. Never put secrets here: the
   * transport owns Authorization and refuses preset overrides.
   */
  headers?: Record<string, string>;
  /** Shown under the field, e.g. free-tier limits. */
  notes?: string;
  suggestedModels?: SuggestedModel[];
}

export const DEFAULT_PRESET_ID = 'openai';

const HOSTED_CONTEXT = 24_000;
const LOCAL_CONTEXT = 12_000;
const DEFAULT_MAX_OUTPUT = 2_048;
const LARGE_MAX_OUTPUT = 4_096;
const DEFAULT_TIMEOUT_MS = 45_000;
const OPENCODE_TIMEOUT_MS = 60_000;

/** Stable for the lifetime of the app process; the gateway recommends a per-conversation id. */
const OPENCODE_SESSION_ID = `freehaven-${Math.random().toString(36).slice(2, 10)}`;

function capabilities(
  overrides: Partial<ProviderCapabilities> & Pick<ProviderCapabilities, 'jsonSchema' | 'jsonObject'>,
): ProviderCapabilities {
  return {
    systemRole: true,
    contextChars: HOSTED_CONTEXT,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    openRouterRouting: false,
    ...overrides,
  };
}

const OPENROUTER_FREE_MODELS: SuggestedModel[] = [
  { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', hint: 'Free tier' },
  { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B', hint: 'Free tier' },
  { id: 'xingchen-agi/xing4.0-29b-a4b:free', label: 'Xing 4.0 29B', hint: 'Free tier' },
  { id: 'dots-studio/dots-3-note-preview:free', label: 'Dots 3 Note', hint: 'Free tier' },
  { id: 'recursive/flint-v1.0:free', label: 'Flint v1', hint: 'Free tier' },
  { id: 'liquid/lfm-2.5-2.6b:free', label: 'LFM 2.5 2.6B', hint: 'Free tier' },
  { id: 'nvidia/nemotron-3.5-super-vl:free', label: 'Nemotron 3.5 Super', hint: 'Free tier' },
  {
    id: 'thinkingmachines/inkling-small:free',
    label: 'Inkling Small',
    hint: 'long context, no JSON mode',
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    label: 'Nemotron 3.5 Lightning',
    hint: 'long context, no JSON mode',
  },
];

export const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemma-4-31b-it:free',
    requiresKey: true,
    capabilities: capabilities({
      jsonSchema: true,
      jsonObject: true,
      maxOutputTokens: LARGE_MAX_OUTPUT,
      openRouterRouting: true,
    }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    notes:
      'Free ids end in :free; ~50 req/day, ~1000/day after ≥10 credits ever purchased; the limit is per account, not per key. Routing requires parameter support.',
    suggestedModels: OPENROUTER_FREE_MODELS,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresKey: true,
    capabilities: capabilities({ jsonSchema: false, jsonObject: true }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    notes: 'Start at json_object; schema support varies by model.',
    suggestedModels: [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' }],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    requiresKey: true,
    capabilities: capabilities({
      jsonSchema: true,
      jsonObject: true,
      maxOutputTokens: LARGE_MAX_OUTPUT,
    }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    notes: 'OpenAI-compatible surface; the seeded model id is editable.',
    suggestedModels: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    requiresKey: true,
    capabilities: capabilities({ jsonSchema: false, jsonObject: true }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    suggestedModels: [{ id: 'mistral-small-latest', label: 'Mistral Small' }],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    requiresKey: true,
    capabilities: capabilities({ jsonSchema: false, jsonObject: true }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    suggestedModels: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
    requiresKey: true,
    capabilities: capabilities({ jsonSchema: false, jsonObject: true }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    notes: 'The seeded model id is editable.',
    suggestedModels: [{ id: 'llama-3.3-70b', label: 'Llama 3.3 70B' }],
  },
  {
    id: 'together',
    label: 'Together',
    baseUrl: 'https://api.together.ai/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    requiresKey: true,
    capabilities: capabilities({ jsonSchema: false, jsonObject: true }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    suggestedModels: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' },
    ],
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    requiresKey: true,
    capabilities: capabilities({ jsonSchema: false, jsonObject: true }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    suggestedModels: [
      {
        id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        label: 'Llama 3.3 70B Instruct',
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
    capabilities: capabilities({
      jsonSchema: true,
      jsonObject: true,
      maxOutputTokens: LARGE_MAX_OUTPUT,
    }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    suggestedModels: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
      { id: 'gpt-4o', label: 'GPT-4o' },
    ],
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    defaultModel: 'deepseek-v4.1-flash',
    requiresKey: true,
    capabilities: capabilities({
      jsonSchema: false,
      jsonObject: true,
      contextChars: HOSTED_CONTEXT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT,
    }),
    timeoutMs: OPENCODE_TIMEOUT_MS,
    headers: {
      'User-Agent': 'Freehaven/1.0',
      'x-opencode-session': OPENCODE_SESSION_ID,
    },
    notes:
      'Subscription key from opencode.ai/console; DeepSeek V4.1 Flash needs Regions = Global in the console privacy settings.',
    suggestedModels: [
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
      { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash' },
      { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash' },
      { id: 'minimax-m3.1-flash', label: 'MiniMax M3.1 Flash' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
      { id: 'mimo-v2.6-flash', label: 'MiMo-V2.6-Flash' },
      { id: 'longcat-2.0', label: 'LongCat-2.0' },
      { id: 'step-5-preview', label: 'Step 5 Preview' },
      { id: 'beam-free', label: 'Beam', hint: 'Free / limited time' },
      { id: 'iceman-contributor-free', label: 'Iceman Contributor', hint: 'Free / limited time' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (LAN)',
    baseUrl: 'http://<lan-ip>:11434/v1',
    defaultModel: 'llama3.2',
    requiresKey: false,
    capabilities: capabilities({
      jsonSchema: false,
      jsonObject: false,
      contextChars: LOCAL_CONTEXT,
    }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    notes: 'Plain HTTP is blocked by Android by default for non-loopback addresses. Start at prompt_only.',
    suggestedModels: [{ id: 'llama3.2', label: 'Llama 3.2' }],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (LAN)',
    baseUrl: 'http://<lan-ip>:1234/v1',
    defaultModel: 'local-model',
    requiresKey: false,
    capabilities: capabilities({
      jsonSchema: false,
      jsonObject: false,
      contextChars: LOCAL_CONTEXT,
    }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    notes: 'Plain HTTP is blocked by Android by default for non-loopback addresses. Start at prompt_only.',
    suggestedModels: [{ id: 'local-model', label: 'Local model' }],
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    defaultModel: '',
    requiresKey: true,
    capabilities: capabilities({
      jsonSchema: false,
      jsonObject: false,
      contextChars: LOCAL_CONTEXT,
    }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    notes: 'User supplies the base URL and model; the strategy ladder auto-downgrades.',
  },
] as const;

const PRESET_BY_ID = new Map<string, ProviderPreset>(PRESETS.map((preset) => [preset.id, preset]));

export const CUSTOM_PRESET = PRESET_BY_ID.get('custom') as ProviderPreset;

/** Unknown ids resolve to the custom preset. Never throws. */
export function getPreset(id: string): ProviderPreset {
  return PRESET_BY_ID.get(id) ?? CUSTOM_PRESET;
}

function normaliseUrl(baseUrl: string): string {
  return baseUrl.trim().toLowerCase().replace(/\/+$/, '');
}

const HOST_PATTERNS: { id: string; pattern: RegExp }[] = [
  { id: 'openai', pattern: /(^|\.)api\.openai\.com$/ },
  { id: 'openrouter', pattern: /(^|\.)openrouter\.ai$/ },
  { id: 'groq', pattern: /(^|\.)api\.groq\.com$/ },
  { id: 'gemini', pattern: /(^|\.)generativelanguage\.googleapis\.com$/ },
  { id: 'mistral', pattern: /(^|\.)api\.mistral\.ai$/ },
  { id: 'deepseek', pattern: /(^|\.)api\.deepseek\.com$/ },
  { id: 'cerebras', pattern: /(^|\.)api\.cerebras\.ai$/ },
  { id: 'together', pattern: /(^|\.)api\.together\.(ai|xyz)$/ },
  { id: 'fireworks', pattern: /(^|\.)api\.fireworks\.ai$/ },
];

/** Map a base URL onto a preset id; unknown/local URLs fall back to custom. */
export function inferPresetId(baseUrl: string): string {
  const url = normaliseUrl(baseUrl ?? '');
  if (!url) return 'custom';

  for (const preset of PRESETS) {
    if (preset.baseUrl && normaliseUrl(preset.baseUrl) === url) return preset.id;
  }

  let host = '';
  let port = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port;
  } catch {
    return 'custom';
  }

  for (const { id, pattern } of HOST_PATTERNS) {
    if (pattern.test(host)) return id;
  }
  // Ollama and LM Studio are identified by their conventional local ports.
  if (port === '11434') return 'ollama';
  if (port === '1234') return 'lmstudio';
  return 'custom';
}

/**
 * Ordered strategy ladder.
 *
 * An override wins outright; a learned value wins over the defaults; otherwise
 * every supported rung is tried in order and `prompt_only` is always last.
 */
export function resolveCapabilities(
  preset: ProviderPreset,
  override: ResponseStrategy | 'auto',
  learned: ResponseStrategy | null,
): { strategies: ResponseStrategy[]; capabilities: ProviderCapabilities } {
  const caps = preset.capabilities;
  if (override !== 'auto') {
    return { strategies: [override], capabilities: caps };
  }
  if (learned) {
    return { strategies: [learned], capabilities: caps };
  }
  const strategies: ResponseStrategy[] = [];
  if (caps.jsonSchema) strategies.push('json_schema');
  if (caps.jsonObject) strategies.push('json_object');
  strategies.push('prompt_only');
  return { strategies, capabilities: caps };
}
