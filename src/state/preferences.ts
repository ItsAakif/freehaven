import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import Storage from 'expo-sqlite/kv-store';

export type ThemeMode = 'system' | 'light' | 'dark' | 'reading';
export type AiProviderKind = 'local' | 'openai-compatible';
export type TextSize = 'sm' | 'md' | 'lg' | 'xl';

type PreferencesState = {
  hydrated: boolean;
  themeMode: ThemeMode;
  textSize: TextSize;
  narrationRate: number;
  narrationVoice: string | null;
  narrationLanguage: string;
  studioVoice: boolean;
  speechModel: string;
  speechVoice: string;
  aiProvider: AiProviderKind;
  aiBaseUrl: string;
  aiModel: string;
  /** Never persisted: the key lives in SecureStore only. */
  aiKeyPresent: boolean;
  dailyGoalMinutes: number;
  remindersEnabled: boolean;
  reminderHour: number;
  analyticsEnabled: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  setTextSize: (size: TextSize) => void;
  setNarrationRate: (rate: number) => void;
  setNarrationVoice: (voice: string | null) => void;
  setNarrationLanguage: (language: string) => void;
  setStudioVoice: (enabled: boolean) => void;
  setSpeechModel: (model: string) => void;
  setSpeechVoice: (voice: string) => void;
  setAiProvider: (provider: AiProviderKind) => void;
  setAiBaseUrl: (url: string) => void;
  setAiModel: (model: string) => void;
  setAiKeyPresent: (present: boolean) => void;
  setDailyGoalMinutes: (minutes: number) => void;
  setRemindersEnabled: (enabled: boolean) => void;
  setReminderHour: (hour: number) => void;
  setAnalyticsEnabled: (enabled: boolean) => void;
};

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      hydrated: false,
      themeMode: 'system',
      textSize: 'md',
      narrationRate: 1,
      narrationVoice: null,
      narrationLanguage: 'en-US',
      studioVoice: false,
      speechModel: 'tts-1',
      speechVoice: 'alloy',
      aiProvider: 'local',
      aiBaseUrl: 'https://api.openai.com/v1',
      aiModel: 'gpt-4o-mini',
      aiKeyPresent: false,
      dailyGoalMinutes: 15,
      remindersEnabled: false,
      reminderHour: 20,
      analyticsEnabled: false,
      setThemeMode: (themeMode) => set({ themeMode }),
      setTextSize: (textSize) => set({ textSize }),
      setNarrationRate: (narrationRate) => set({ narrationRate }),
      setNarrationVoice: (narrationVoice) => set({ narrationVoice }),
      setNarrationLanguage: (narrationLanguage) => set({ narrationLanguage }),
      setStudioVoice: (studioVoice) => set({ studioVoice }),
      setSpeechModel: (speechModel) => set({ speechModel }),
      setSpeechVoice: (speechVoice) => set({ speechVoice }),
      setAiProvider: (aiProvider) => set({ aiProvider }),
      setAiBaseUrl: (aiBaseUrl) => set({ aiBaseUrl }),
      setAiModel: (aiModel) => set({ aiModel }),
      setAiKeyPresent: (aiKeyPresent) => set({ aiKeyPresent }),
      setDailyGoalMinutes: (dailyGoalMinutes) => set({ dailyGoalMinutes }),
      setRemindersEnabled: (remindersEnabled) => set({ remindersEnabled }),
      setReminderHour: (reminderHour) => set({ reminderHour }),
      setAnalyticsEnabled: (analyticsEnabled) => set({ analyticsEnabled }),
    }),
    {
      name: 'freehaven-preferences',
      storage: createJSONStorage(() => ({
        getItem: (key: string) => Storage.getItem(key),
        setItem: (key: string, value: string) => Storage.setItem(key, value),
        removeItem: (key: string) => Storage.removeItem(key),
      })),
      partialize: (state) => {
        const { hydrated: _hydrated, aiKeyPresent: _key, ...rest } = state;
        return rest;
      },
      onRehydrateStorage: () => (state) => {
        state?.setAiKeyPresent(state.aiKeyPresent);
        usePreferences.setState({ hydrated: true });
      },
    },
  ),
);
