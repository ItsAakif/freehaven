import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  AppText,
  Card,
  Button,
  Header,
  Chip,
  Field,
  Divider,
  Sheet,
  Stat,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { usePreferences, type TextSize, type ThemeMode } from '@/state/preferences';
import { clearStoredKey, getStoredKey, setStoredKey } from '@/ai';
import { dataCounts, deleteAllUserData } from '@/data/repositories/learning';
import { getProfile, saveProfile } from '@/data/repositories/profile';
import { exportUserData, formatBytes, storageUsage, clearCaches } from '@/features/data/export';
import { NARRATION_LANGUAGES } from '@/features/audio';
import { useAsync } from '@/hooks/useAsync';
import { useDatabase } from '@/data/DatabaseProvider';

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'reading', label: 'Warm' },
];

const SIZES: { id: TextSize; label: string }[] = [
  { id: 'sm', label: 'S' },
  { id: 'md', label: 'M' },
  { id: 'lg', label: 'L' },
  { id: 'xl', label: 'XL' },
];

export default function SettingsScreen() {
  const { palette } = useTheme();
  useDatabase();
  const prefs = usePreferences();
  const [aiOpen, setAiOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(prefs.aiBaseUrl);
  const [model, setModel] = useState(prefs.aiModel);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyState, setKeyState] = useState<'unknown' | 'present' | 'absent'>('unknown');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tick, setTick] = useState(0);

  const usage = useAsync(async () => {
    const [counts, storage, key, profile] = await Promise.all([
      dataCounts(),
      storageUsage(),
      getStoredKey(),
      getProfile(),
    ]);
    setKeyState(key ? 'present' : 'absent');
    return { counts, storage, profile };
  }, [tick]);

  const saveAi = async () => {
    setBusy('ai');
    setActionError(null);
    try {
      prefs.setAiBaseUrl(baseUrl.trim());
      prefs.setAiModel(model.trim());
      if (keyDraft.trim()) await setStoredKey(keyDraft.trim());
      setKeyDraft('');
      setKeyState((await getStoredKey()) ? 'present' : 'absent');
      setAiOpen(false);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exportData = async () => {
    setBusy('export');
    setActionError(null);
    try {
      const { uri } = await exportUserData();
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'Export Freehaven data' });
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleReminders = async (enabled: boolean) => {
    setActionError(null);
    try {
      if (!enabled) {
        await Notifications.cancelAllScheduledNotificationsAsync();
        prefs.setRemindersEnabled(false);
        return;
      }
      const permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) {
        setActionError('Notifications are blocked in system settings.');
        return;
      }
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'A few minutes for review?',
          body: 'Your due cards are ready. Even five minutes keeps the thread.',
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: prefs.reminderHour,
          minute: 0,
        },
      });
      prefs.setRemindersEnabled(true);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const removeAll = async () => {
    setBusy('delete');
    try {
      await deleteAllUserData();
      setConfirmDelete(false);
      setTick((t) => t + 1);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Header title="Settings" onBack={() => router.back()} />

      <AppText variant="label" muted>
        Appearance
      </AppText>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        {THEMES.map((theme) => (
          <Chip key={theme.id} label={theme.label} active={prefs.themeMode === theme.id} onPress={() => prefs.setThemeMode(theme.id)} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
        <AppText variant="bodySm" muted style={{ flex: 1 }}>
          Text size
        </AppText>
        {SIZES.map((size) => (
          <Chip key={size.id} label={size.label} active={prefs.textSize === size.id} onPress={() => prefs.setTextSize(size.id)} />
        ))}
      </View>

      <Divider />
      <AppText variant="label" muted>
        Daily target
      </AppText>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {[10, 15, 20, 30].map((minutes) => (
          <Chip
            key={minutes}
            label={`${minutes} min`}
            active={prefs.dailyGoalMinutes === minutes}
            onPress={() => {
              prefs.setDailyGoalMinutes(minutes);
              void saveProfile({ minutesPerDay: minutes }).then(() => setTick((t) => t + 1));
            }}
          />
        ))}
      </View>
      <AppText variant="caption" faint>
        Reading and reviews count toward it. Currently {usage.data?.profile.minutesPerDay ?? prefs.dailyGoalMinutes} min/day
        {usage.data?.profile.goal ? ` · ${usage.data.profile.goal}` : ''}.
      </AppText>

      <Divider />
      <AppText variant="label" muted>
        Narration speed
      </AppText>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {[0.75, 1, 1.25, 1.5].map((rate) => (
          <Chip key={rate} label={`${rate}×`} active={prefs.narrationRate === rate} onPress={() => prefs.setNarrationRate(rate)} />
        ))}
      </View>

      <AppText variant="label" muted>
        Narration language
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {NARRATION_LANGUAGES.map((option) => (
          <Chip
            key={option.id}
            label={option.label}
            active={prefs.narrationLanguage === option.id}
            onPress={() => prefs.setNarrationLanguage(option.id)}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <AppText variant="bodySm" style={{ fontWeight: '600' }}>
            Studio narration
          </AppText>
          <AppText variant="caption" faint>
            {prefs.aiKeyPresent
              ? 'Synthesise MP3s with your remote provider, cache them, and use lock-screen controls.'
              : 'Requires a remote key. Device speech always works offline.'}
          </AppText>
        </View>
        <Switch
          value={prefs.studioVoice}
          onValueChange={prefs.setStudioVoice}
          disabled={!prefs.aiKeyPresent}
          trackColor={{ true: palette.accent, false: palette.line }}
          thumbColor={palette.surface}
        />
      </View>
      {prefs.studioVoice && prefs.aiKeyPresent ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Field label="Speech model" value={prefs.speechModel} onChangeText={prefs.setSpeechModel} autoCapitalize="none" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Voice" value={prefs.speechVoice} onChangeText={prefs.setSpeechVoice} autoCapitalize="none" />
          </View>
        </View>
      ) : null}

      <Divider />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <AppText variant="bodySm" style={{ fontWeight: '600' }}>
            Daily review reminder
          </AppText>
          <AppText variant="caption" faint>
            One local notification at {prefs.reminderHour}:00. No server involved.
          </AppText>
        </View>
        <Switch
          value={prefs.remindersEnabled}
          onValueChange={(value) => void toggleReminders(value)}
          trackColor={{ true: palette.accent, false: palette.line }}
          thumbColor={palette.surface}
        />
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {[8, 12, 20].map((hour) => (
          <Chip key={hour} label={`${hour}:00`} active={prefs.reminderHour === hour} onPress={() => prefs.setReminderHour(hour)} />
        ))}
      </View>

      <Divider />
      <AppText variant="label" muted>
        AI provider
      </AppText>
      <Card onPress={() => setAiOpen(true)} style={{ paddingVertical: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Ionicons name={prefs.aiProvider === 'local' ? 'phone-portrait-outline' : 'cloud-outline'} size={18} color={palette.accent} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodySm" style={{ fontWeight: '600' }}>
              {prefs.aiProvider === 'local' ? 'On-device extractive' : `Remote · ${prefs.aiModel || 'not configured'}`}
            </AppText>
            <AppText variant="caption" faint>
              {prefs.aiProvider === 'local'
                ? 'No key, no network. Answers are extracted from your own text.'
                : keyState === 'present'
                  ? 'Key stored in the device keychain.'
                  : 'No key saved yet.'}
            </AppText>
          </View>
          <Ionicons name="chevron-forward" size={16} color={palette.inkFaint} />
        </View>
      </Card>

      <Divider />
      <AppText variant="label" muted>
        Your data
      </AppText>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat value={String(usage.data?.counts.books ?? 0)} label="books" />
          <Stat value={String(usage.data?.counts.highlights ?? 0)} label="highlights" />
          <Stat value={String(usage.data?.counts.cards ?? 0)} label="cards" />
          <Stat value={String(usage.data?.counts.conversations ?? 0)} label="chats" />
        </View>
        <Divider style={{ marginVertical: space.md }} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <AppText variant="caption" muted>
            Documents on device
          </AppText>
          <AppText variant="caption">{formatBytes(usage.data?.storage.libraryBytes ?? 0)}</AppText>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
          <AppText variant="caption" muted>
            Download cache
          </AppText>
          <AppText variant="caption">{formatBytes(usage.data?.storage.cacheBytes ?? 0)}</AppText>
        </View>
      </Card>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button
          label="Export JSON"
          icon="download-outline"
          variant="secondary"
          size="sm"
          loading={busy === 'export'}
          onPress={() => void exportData()}
        />
        <Button
          label="Clear cache"
          icon="refresh-outline"
          variant="secondary"
          size="sm"
          onPress={() => {
            clearCaches();
            setTick((t) => t + 1);
          }}
        />
        <Button label="Delete all data" icon="trash-outline" variant="danger" size="sm" onPress={() => setConfirmDelete(true)} />
      </View>

      {actionError ? (
        <AppText variant="caption" color={palette.danger}>
          {actionError}
        </AppText>
      ) : null}

      <Divider />
      <AppText variant="label" muted>
        About
      </AppText>
      <AppText variant="caption" faint>
        Freehaven 0.1.0 · open source, local-first. No accounts, no ads, no telemetry. Public-domain texts come from
        Project Gutenberg; catalogue metadata from Open Library and Google Books under their terms.
      </AppText>

      <Sheet visible={aiOpen} onClose={() => setAiOpen(false)} title="AI provider">
        <AppText variant="caption" muted>
          The on-device extractive engine always works. A remote model is optional and only used when you ask a
          question or generate a lesson.
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Chip label="On-device" active={prefs.aiProvider === 'local'} onPress={() => prefs.setAiProvider('local')} />
          <Chip label="Remote" active={prefs.aiProvider === 'openai-compatible'} onPress={() => prefs.setAiProvider('openai-compatible')} />
        </View>
        <Field label="Base URL" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" placeholder="https://api.openai.com/v1" />
        <Field label="Model" value={model} onChangeText={setModel} autoCapitalize="none" placeholder="gpt-4o-mini" />
        <Field
          label={keyState === 'present' ? 'Replace API key (saved)' : 'API key'}
          value={keyDraft}
          onChangeText={setKeyDraft}
          secureTextEntry
          autoCapitalize="none"
          placeholder="sk-…"
          hint="Stored in SecureStore / Keychain. Never bundled, never logged."
        />
        <Button label="Save" onPress={() => void saveAi()} loading={busy === 'ai'} full />
        {keyState === 'present' ? (
          <Button
            label="Remove saved key"
            variant="ghost"
            full
            onPress={() =>
              void (async () => {
                await clearStoredKey();
                setKeyState('absent');
              })()
            }
          />
        ) : null}
      </Sheet>

      <Sheet visible={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete all data?">
        <AppText variant="bodySm" muted>
          This removes your imported documents, extracted text, notes, highlights, lessons, cards and conversations from
          this device. It cannot be undone. Export first if you want a copy.
        </AppText>
        <Button label="Delete everything" variant="danger" full loading={busy === 'delete'} onPress={() => void removeAll()} />
        <Button label="Cancel" variant="ghost" full onPress={() => setConfirmDelete(false)} />
      </Sheet>
    </Screen>
  );
}
