import { getStoredKey } from '@/ai';
import { usePreferences } from '@/state/preferences';
import { RemoteSpeechProvider } from './providers';

/** Studio narration is opt-in and only exists when a remote key is configured. */
export async function resolveSpeechProvider(): Promise<RemoteSpeechProvider | null> {
  const prefs = usePreferences.getState();
  if (!prefs.studioVoice) return null;
  const key = await getStoredKey();
  if (!key) return null;
  return new RemoteSpeechProvider({ baseUrl: prefs.aiBaseUrl, apiKey: key });
}

export * from './providers';
