import * as SecureStore from 'expo-secure-store';
import { clearStoredKey, getStoredKey, setStoredKey } from '@/ai/keys';

jest.mock('expo-secure-store', () => {
  const entries = new Map<string, string>();
  return {
    __entries: entries,
    getItemAsync: jest.fn(async (key: string) => entries.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      entries.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      entries.delete(key);
    }),
  };
});

const LEGACY_KEY = 'freehaven.ai.apiKey';
const entries = (SecureStore as unknown as { __entries: Map<string, string> }).__entries;
const scoped = (presetId: string) => `ai.key.${presetId}`;

describe('per-preset API key storage', () => {
  beforeEach(() => {
    entries.clear();
  });

  it('adopts the legacy key for the first preset read only', async () => {
    entries.set(LEGACY_KEY, 'sk-legacy');

    await expect(getStoredKey('openrouter')).resolves.toBe('sk-legacy');
    expect(entries.get(scoped('openrouter'))).toBe('sk-legacy');
    expect(entries.has(LEGACY_KEY)).toBe(false);

    await expect(getStoredKey('groq')).resolves.toBeNull();
    expect(entries.has(scoped('groq'))).toBe(false);
  });

  it('never shares a saved key across presets', async () => {
    await setStoredKey('sk-openrouter', 'openrouter');
    await setStoredKey('sk-groq', 'groq');

    await expect(getStoredKey('openrouter')).resolves.toBe('sk-openrouter');
    await expect(getStoredKey('groq')).resolves.toBe('sk-groq');
    await expect(getStoredKey('openai')).resolves.toBeNull();
    expect(entries.has(scoped('openai'))).toBe(false);
  });

  it('removes only the active preset key', async () => {
    await setStoredKey('sk-openrouter', 'openrouter');
    await setStoredKey('sk-groq', 'groq');

    await clearStoredKey('openrouter');

    await expect(getStoredKey('openrouter')).resolves.toBeNull();
    await expect(getStoredKey('groq')).resolves.toBe('sk-groq');
  });

  it('does not resurrect an adopted legacy key after removal', async () => {
    entries.set(LEGACY_KEY, 'sk-legacy');
    await getStoredKey('openrouter');

    await clearStoredKey('openrouter');

    await expect(getStoredKey('openrouter')).resolves.toBeNull();
    expect(entries.has(LEGACY_KEY)).toBe(false);
  });

  it('returns null for an unknown preset and leaves the legacy key alone', async () => {
    entries.set(LEGACY_KEY, 'sk-legacy');

    await expect(getStoredKey('not-a-preset')).resolves.toBeNull();
    expect(entries.get(LEGACY_KEY)).toBe('sk-legacy');

    await expect(getStoredKey('openrouter')).resolves.toBe('sk-legacy');
  });

  it('does not adopt the legacy key into a preset that needs none', async () => {
    entries.set(LEGACY_KEY, 'sk-legacy');

    await expect(getStoredKey('ollama')).resolves.toBeNull();
    expect(entries.has(scoped('ollama'))).toBe(false);
    expect(entries.get(LEGACY_KEY)).toBe('sk-legacy');

    // The first preset that actually asks for a key still adopts it.
    await expect(getStoredKey('openrouter')).resolves.toBe('sk-legacy');
  });

  it('treats an empty save as removal', async () => {
    await setStoredKey('sk-openrouter', 'openrouter');

    await setStoredKey('   ', 'openrouter');

    await expect(getStoredKey('openrouter')).resolves.toBeNull();
  });
});
