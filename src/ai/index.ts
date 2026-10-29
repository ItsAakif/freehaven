import * as SecureStore from 'expo-secure-store';
import { usePreferences } from '@/state/preferences';
import { extractiveProvider } from './extractive';
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

/** Resolve the configured provider, falling back to on-device extraction. */
export async function resolveProvider(): Promise<AiProvider> {
  const prefs = usePreferences.getState();
  if (prefs.aiProvider !== 'openai-compatible') return extractiveProvider;
  const key = await getStoredKey();
  if (!key || !prefs.aiBaseUrl || !prefs.aiModel) return extractiveProvider;
  return new OpenAiCompatibleProvider({
    baseUrl: prefs.aiBaseUrl,
    model: prefs.aiModel,
    apiKey: key,
  });
}

export async function currentProviderLabel(): Promise<string> {
  const provider = await resolveProvider();
  return provider.label;
}
