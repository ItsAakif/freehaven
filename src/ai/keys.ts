/**
 * Per-preset API key storage.
 *
 * Storage and migration rule
 * --------------------------
 * Each preset owns exactly one SecureStore entry, `ai.key.<presetId>`.
 *
 * Older builds stored a single global key at `freehaven.ai.apiKey`. That entry
 * is adopted once, by the first preset that asks for a key: when the preset has
 * no namespaced entry but the legacy entry exists, the value is moved into that
 * preset's entry and the legacy entry is deleted. It is never copied to any
 * other preset, so one provider's credential cannot be sent to another. From
 * then on the preset keeps that key until the user saves or removes one for it.
 *
 * Unknown preset ids own nothing and always resolve to null.
 */

import * as SecureStore from 'expo-secure-store';
import { usePreferences } from '@/state/preferences';
import { PRESETS } from './presets';

const LEGACY_KEY = 'freehaven.ai.apiKey';
const KEY_PREFIX = 'ai.key.';

const PRESET_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

function storageKeyFor(presetId: string): string | null {
  const preset = PRESET_BY_ID.get(presetId);
  return preset ? `${KEY_PREFIX}${preset.id}` : null;
}

export async function getStoredKey(presetId: string): Promise<string | null> {
  const storageKey = storageKeyFor(presetId);
  if (!storageKey) return null;
  const preset = PRESET_BY_ID.get(presetId);
  try {
    const scoped = await SecureStore.getItemAsync(storageKey);
    if (scoped) return scoped;

    // A preset that does not ask for a key never inherits a hosted credential.
    if (!preset?.requiresKey) return null;

    // One-time adoption of the pre-namespacing key. Move, never copy.
    const legacy = await SecureStore.getItemAsync(LEGACY_KEY);
    if (!legacy) return null;
    await SecureStore.setItemAsync(storageKey, legacy);
    await SecureStore.deleteItemAsync(LEGACY_KEY);
    return legacy;
  } catch {
    return null;
  }
}

export async function setStoredKey(key: string, presetId: string): Promise<void> {
  const storageKey = storageKeyFor(presetId);
  if (!storageKey) return;
  if (!key.trim()) {
    await SecureStore.deleteItemAsync(storageKey);
    usePreferences.getState().setAiKeyPresent(false);
    return;
  }
  await SecureStore.setItemAsync(storageKey, key.trim());
  usePreferences.getState().setAiKeyPresent(true);
}

export async function clearStoredKey(presetId: string): Promise<void> {
  const storageKey = storageKeyFor(presetId);
  if (!storageKey) return;
  await SecureStore.deleteItemAsync(storageKey);
  usePreferences.getState().setAiKeyPresent(false);
}
