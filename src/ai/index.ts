import * as SecureStore from 'expo-secure-store';
import { usePreferences } from '@/state/preferences';
import { extractiveProvider } from './extractive';
import { getPreset } from './presets';
import { OpenAiCompatibleProvider } from './remote';
import type { AiProvider } from './types';

const KEY = 'freehaven.ai.apiKey';

export async function getStoredKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function setStoredKey(key: string): Promise<void> {
  if (!key.trim()) {
    await SecureStore.deleteItemAsync(KEY);
    usePreferences.getState().setAiKeyPresent(false);
    return;
  }
  await SecureStore.setItemAsync(KEY, key.trim());
  usePreferences.getState().setAiKeyPresent(true);
}

export async function clearStoredKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
  usePreferences.getState().setAiKeyPresent(false);
}

/**
 * Resolve the configured provider, falling back to on-device extraction.
 *
 * Keyless presets (Ollama / LM Studio) need only a base URL and model; hosted
 * presets also need a stored key. A preset that needs a key but has none is
 * never reported as remote — the label says "On-device extractive" instead.
 */
export async function resolveProvider(): Promise<AiProvider> {
  const prefs = usePreferences.getState();
  if (prefs.aiProvider !== 'openai-compatible') return extractiveProvider;

  const preset = getPreset(prefs.aiPreset);
  const baseUrl = (prefs.aiBaseUrl ?? '').trim();
  const model = (prefs.aiModel ?? '').trim();
  if (!baseUrl || !model) return extractiveProvider;

  const key = await getStoredKey();
  if (preset.requiresKey && !key) return extractiveProvider;

  return new OpenAiCompatibleProvider({
    baseUrl,
    model,
    apiKey: key ?? '',
    presetId: preset.id,
    responseFormat: prefs.aiResponseFormat === 'none' ? 'prompt_only' : prefs.aiResponseFormat,
  });
}

export async function currentProviderLabel(): Promise<string> {
  const provider = await resolveProvider();
  if (provider.id !== 'openai-compatible') return provider.label;

  const prefs = usePreferences.getState();
  const preset = getPreset(prefs.aiPreset);
  const model = (prefs.aiModel ?? '').trim() || preset.defaultModel;
  return `${preset.label} · ${model}`;
}
