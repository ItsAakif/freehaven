import {
  DEFAULT_PRESET_ID,
  PRESETS,
  getPreset,
  inferPresetId,
  resolveCapabilities,
} from '@/ai/presets';

const TABLE_IDS = [
  'openrouter',
  'groq',
  'gemini',
  'mistral',
  'deepseek',
  'cerebras',
  'together',
  'fireworks',
  'openai',
  'ollama',
  'lmstudio',
  'custom',
];

describe('provider presets', () => {
  it('covers every row of the spec table with unique ids', () => {
    expect(PRESETS).toHaveLength(TABLE_IDS.length);
    expect(PRESETS.map((preset) => preset.id).sort()).toEqual([...TABLE_IDS].sort());
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(PRESETS.length);
    for (const preset of PRESETS) {
      expect(preset.label.trim()).not.toBe('');
      expect(preset.capabilities.contextChars).toBeGreaterThan(0);
      expect(preset.capabilities.maxOutputTokens).toBeGreaterThan(0);
      expect(preset.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('resolves unknown preset ids to custom', () => {
    expect(getPreset('nope').id).toBe('custom');
    expect(getPreset('openai').id).toBe('openai');
    expect(DEFAULT_PRESET_ID).toBe('openai');
  });

  it('infers presets from base URLs regardless of case or trailing slash', () => {
    expect(inferPresetId('https://api.openai.com/v1')).toBe('openai');
    expect(inferPresetId('https://api.openai.com/v1/')).toBe('openai');
    expect(inferPresetId('HTTPS://API.OPENAI.COM/V1')).toBe('openai');
    expect(inferPresetId('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(inferPresetId('https://api.groq.com/openai/v1/')).toBe('groq');
    expect(inferPresetId('http://192.168.1.10:11434/v1')).toBe('ollama');
    expect(inferPresetId('http://192.168.1.10:1234/v1')).toBe('lmstudio');
    expect(inferPresetId('http://localhost:11434/v1')).toBe('ollama');
    expect(inferPresetId('')).toBe('custom');
    expect(inferPresetId('https://nonsense.example.com/v1')).toBe('custom');
    expect(inferPresetId('not a url')).toBe('custom');
  });

  it('builds the full ladder for capable presets', () => {
    const { strategies } = resolveCapabilities(getPreset('openai'), 'auto', null);
    expect(strategies).toEqual(['json_schema', 'json_object', 'prompt_only']);
  });

  it('filters unsupported rungs but always ends with prompt_only', () => {
    expect(resolveCapabilities(getPreset('groq'), 'auto', null).strategies).toEqual([
      'json_object',
      'prompt_only',
    ]);
    expect(resolveCapabilities(getPreset('ollama'), 'auto', null).strategies).toEqual([
      'prompt_only',
    ]);
    for (const preset of PRESETS) {
      const { strategies } = resolveCapabilities(preset, 'auto', null);
      expect(strategies.at(-1)).toBe('prompt_only');
      expect(strategies.length).toBeGreaterThan(0);
    }
  });

  it('lets an override win and disable the ladder', () => {
    const { strategies } = resolveCapabilities(getPreset('groq'), 'json_schema', 'prompt_only');
    expect(strategies).toEqual(['json_schema']);
  });

  it('lets a learned value win over the defaults', () => {
    expect(resolveCapabilities(getPreset('openai'), 'auto', 'json_object').strategies).toEqual([
      'json_object',
    ]);
  });
});
