import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import Storage from 'expo-sqlite/kv-store';
import { coerceNarrationStyle } from '@/features/narration/styles';
import type {
  NarrationLength,
  NarrationStyleId,
  RenditionEngine,
} from '@/domain/narration';
import { migratePreferences } from './preferencesMigration';

export type ThemeMode = 'system' | 'light' | 'dark' | 'reading';
export type AiProviderKind = 'local' | 'openai-compatible';
export type TextSize = 'sm' | 'md' | 'lg' | 'xl';
export type AiResponseFormat = 'auto' | 'json_schema' | 'json_object' | 'none';

export type PreferencesState = {
  hydrated: boolean;
  themeMode: ThemeMode;
  textSize: TextSize;
  narrationRate: number;
  narrationVoice: string | null;
  narrationLanguage: string;
  /**
   * Stored as a NarrationStyleId; legacy values are coerced on write and on
   * rehydrate, so a hand-edited store can never select an unknown style.
   */
  narrationStyle: NarrationStyleId;
  narrationLength: NarrationLength;
  narrationEngine: RenditionEngine;
  narrationInstruction: string;
  narrationModelBundle: string | null;
  /** Kokoro voice index override; null follows the active style default. */
  narrationKokoroSpeaker: number | null;
  /** Derived convenience: true exactly when narrationEngine === 'remote'. */
  studioVoice: boolean;
  speechModel: string;
  speechVoice: string;
  aiProvider: AiProviderKind;
  aiPreset: string;
  aiResponseFormat: AiResponseFormat;
  aiBaseUrl: string;
  aiModel: string;
  /** Never persisted: the key lives in SecureStore only. */
  aiKeyPresent: boolean;
  dailyGoalMinutes: number;
  remindersEnabled: boolean;
  reminderHour: number;
  analyticsEnabled: boolean;
  /** One local notification when a narration job finishes while the app is open. */
  generationNotifications: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  setTextSize: (size: TextSize) => void;
  setNarrationRate: (rate: number) => void;
  setNarrationVoice: (voice: string | null) => void;
  setNarrationLanguage: (language: string) => void;
  setNarrationStyle: (style: NarrationStyleId) => void;
  setNarrationLength: (length: NarrationLength) => void;
  setNarrationEngine: (engine: RenditionEngine) => void;
  setNarrationInstruction: (instruction: string) => void;
  setNarrationModelBundle: (bundle: string | null) => void;
  setNarrationKokoroSpeaker: (speaker: number | null) => void;
  setStudioVoice: (enabled: boolean) => void;
  setSpeechModel: (model: string) => void;
  setSpeechVoice: (voice: string) => void;
  setAiProvider: (provider: AiProviderKind) => void;
  setAiPreset: (preset: string) => void;
  setAiResponseFormat: (format: AiResponseFormat) => void;
  setAiBaseUrl: (url: string) => void;
  setAiModel: (model: string) => void;
  setAiKeyPresent: (present: boolean) => void;
  setDailyGoalMinutes: (minutes: number) => void;
  setRemindersEnabled: (enabled: boolean) => void;
  setReminderHour: (hour: number) => void;
  setAnalyticsEnabled: (enabled: boolean) => void;
  setGenerationNotifications: (enabled: boolean) => void;
};

const ENGINES: readonly RenditionEngine[] = ['device', 'remote', 'piper', 'kokoro'];

function isNarrationEngine(value: unknown): value is RenditionEngine {
  return typeof value === 'string' && (ENGINES as readonly string[]).includes(value);
}

/** Defensive read-time coercion, including for hand-edited version-2 stores. */
function reconcileNarration(state: PreferencesState): PreferencesState {
  const engine = isNarrationEngine(state.narrationEngine)
    ? state.narrationEngine
    : state.studioVoice
      ? 'remote'
      : 'device';
  const kokoroSpeaker =
    typeof state.narrationKokoroSpeaker === 'number' &&
    Number.isFinite(state.narrationKokoroSpeaker) &&
    state.narrationKokoroSpeaker >= 0
      ? Math.floor(state.narrationKokoroSpeaker)
      : null;
  return {
    ...state,
    narrationStyle: coerceNarrationStyle(state.narrationStyle),
    narrationEngine: engine,
    narrationKokoroSpeaker: kokoroSpeaker,
    studioVoice: engine === 'remote',
  };
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      hydrated: false,
      themeMode: 'system',
      textSize: 'md',
      narrationRate: 1,
      narrationVoice: null,
      narrationLanguage: 'en-US',
      narrationStyle: 'fireside',
      narrationLength: '15',
      narrationEngine: 'device',
      narrationInstruction: '',
      narrationModelBundle: null,
      narrationKokoroSpeaker: null,
      studioVoice: false,
      speechModel: 'tts-1',
      speechVoice: 'alloy',
      aiProvider: 'local',
      aiPreset: 'openai',
      aiResponseFormat: 'auto',
      aiBaseUrl: 'https://api.openai.com/v1',
      aiModel: 'gpt-4o-mini',
      aiKeyPresent: false,
      dailyGoalMinutes: 15,
      remindersEnabled: false,
      reminderHour: 20,
      analyticsEnabled: false,
      generationNotifications: false,
      setThemeMode: (themeMode) => set({ themeMode }),
      setTextSize: (textSize) => set({ textSize }),
      setNarrationRate: (narrationRate) => set({ narrationRate }),
      setNarrationVoice: (narrationVoice) => set({ narrationVoice }),
      setNarrationLanguage: (narrationLanguage) => set({ narrationLanguage }),
      setNarrationStyle: (style) => set({ narrationStyle: coerceNarrationStyle(style) }),
      setNarrationLength: (narrationLength) => set({ narrationLength }),
      setNarrationEngine: (narrationEngine) =>
        set({ narrationEngine, studioVoice: narrationEngine === 'remote' }),
      setNarrationInstruction: (narrationInstruction) => set({ narrationInstruction }),
      setNarrationModelBundle: (narrationModelBundle) => set({ narrationModelBundle }),
      setNarrationKokoroSpeaker: (narrationKokoroSpeaker) =>
        set({
          narrationKokoroSpeaker:
            narrationKokoroSpeaker === null
              ? null
              : Math.max(0, Math.floor(narrationKokoroSpeaker)),
        }),
      setStudioVoice: (studioVoice) =>
        set({ studioVoice, narrationEngine: studioVoice ? 'remote' : 'device' }),
      setSpeechModel: (speechModel) => set({ speechModel }),
      setSpeechVoice: (speechVoice) => set({ speechVoice }),
      setAiProvider: (aiProvider) => set({ aiProvider }),
      setAiPreset: (aiPreset) => set({ aiPreset }),
      setAiResponseFormat: (aiResponseFormat) => set({ aiResponseFormat }),
      setAiBaseUrl: (aiBaseUrl) => set({ aiBaseUrl }),
      setAiModel: (aiModel) => set({ aiModel }),
      setAiKeyPresent: (aiKeyPresent) => set({ aiKeyPresent }),
      setDailyGoalMinutes: (dailyGoalMinutes) => set({ dailyGoalMinutes }),
      setRemindersEnabled: (remindersEnabled) => set({ remindersEnabled }),
      setReminderHour: (reminderHour) => set({ reminderHour }),
      setAnalyticsEnabled: (analyticsEnabled) => set({ analyticsEnabled }),
      setGenerationNotifications: (generationNotifications) => set({ generationNotifications }),
    }),
    {
      name: 'freehaven-preferences',
      version: 2,
      storage: createJSONStorage(() => ({
        getItem: (key: string) => Storage.getItem(key),
        setItem: (key: string, value: string) => Storage.setItem(key, value),
        removeItem: (key: string) => Storage.removeItem(key),
      })),
      partialize: (state) => {
        const { hydrated: _hydrated, aiKeyPresent: _key, ...rest } = state;
        return rest;
      },
      migrate: (persisted, version) =>
        migratePreferences(persisted, version) as unknown as PreferencesState,
      merge: (persisted, current) => {
        const saved =
          persisted && typeof persisted === 'object' && !Array.isArray(persisted)
            ? (persisted as Partial<PreferencesState>)
            : {};
        return reconcileNarration({ ...current, ...saved });
      },
      onRehydrateStorage: () => (state) => {
        state?.setAiKeyPresent(state.aiKeyPresent);
        usePreferences.setState({ hydrated: true });
      },
    },
  ),
);
