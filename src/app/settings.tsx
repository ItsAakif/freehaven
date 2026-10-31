import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';
import { Icon } from '@/design/icon';
import { BrandLockup } from '@/design/brand';
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
import { DEFAULT_PRESET_ID, PRESETS, getPreset } from '@/ai/presets';
import { OpenAiCompatibleProvider } from '@/ai/remote';
import { dataCounts, deleteAllUserData } from '@/data/repositories/learning';
import { getProfile, saveProfile } from '@/data/repositories/profile';
import {
  deleteNarrationEngine,
  listNarrationEngines,
  updateNarrationEngine,
  upsertNarrationEngine,
  type NarrationEngineRecord,
} from '@/data/repositories/narrationEngines';
import { exportUserData, formatBytes, storageUsage, clearCaches } from '@/features/data/export';
import { NARRATION_LANGUAGES } from '@/features/audio';
import {
  NARRATION_STYLES,
  getNarrationStyle,
} from '@/features/narration/styles';
import { LENGTH_PRESETS } from '@/features/narration/lengths';
import { MAX_INSTRUCTION_CHARS } from '@/features/narration/script';
import {
  invalidateNarrationProbes,
  probeNarrationEngines,
  type EngineAvailability,
  type EngineUnavailableReason,
} from '@/features/narration/engines';
import {
  MODEL_BUNDLES,
  defaultModelDeps,
  deleteBundle,
  downloadBundle,
  modelDirFor,
  reverifyInstalled,
  type BundleResult,
  type ModelBundle,
} from '@/features/narration/models';
import { useAsync } from '@/hooks/useAsync';
import { useDatabase } from '@/data/DatabaseProvider';
import type { RenditionEngine } from '@/domain/narration';

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

const RESPONSE_FORMATS: {
  id: 'auto' | 'json_schema' | 'json_object' | 'none';
  label: string;
}[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'json_schema', label: 'JSON schema' },
  { id: 'json_object', label: 'JSON object' },
  { id: 'none', label: 'Plain text' },
];

/** Shared with the Listen voice picker through the style defaults. */
const REMOTE_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;

const ENGINE_ROWS: { id: RenditionEngine; label: string; blurb: string }[] = [
  { id: 'device', label: 'Device voice', blurb: 'Offline, built into your phone. Reads the script at your chosen rate.' },
  { id: 'remote', label: 'Remote voice', blurb: 'Needs a provider key and base URL. Produces audio files.' },
  { id: 'piper', label: 'Piper (local)', blurb: 'Fast on-device neural voice. Needs a downloaded model.' },
  { id: 'kokoro', label: 'Kokoro (local)', blurb: 'Richer multi-voice model. Needs a downloaded model.' },
];

const REASON_COPY: Record<EngineUnavailableReason, string> = {
  not_installed: 'This build does not include the local voice engine. Use an engine below, or install the local-voice build.',
  no_model: 'No voice model is installed yet. Download one in Local voices below.',
  load_failed: 'The local voice engine could not start. Re-download the model, or use another engine.',
  model_absent: 'No voice model is downloaded yet. Download one in Local voices below.',
  model_unverified: 'The voice model is incomplete or was moved. Verify it, or import the extracted folder again.',
  needs_extraction: "This build can't unpack the model. Import an extracted folder instead.",
  no_key: 'Add a provider key in the AI provider sheet first.',
  no_base_url: 'Set a provider base URL in the AI provider sheet first.',
  unsupported_platform: 'This device does not support that engine.',
};

/** Two fixed one-sentence passages; never the user's library. */
const TEST_SOURCES = [
  {
    chunkId: 'test-1',
    text: 'The morning train left the coast at seven, carrying the last of the summer visitors inland.',
    sectionTitle: 'Connection test',
  },
  {
    chunkId: 'test-2',
    text: 'A small library kept its lights on through the storm so anyone could read until the rain stopped.',
    sectionTitle: 'Connection test',
  },
] as const;

function validateBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter the base URL for this provider.';
  if (!/^https?:\/\//i.test(trimmed)) return 'Base URL must start with http:// or https://.';
  try {
    // Throws for host-less / malformed URLs that a scheme check alone misses.
    new URL(trimmed);
  } catch {
    return 'That is not a valid URL.';
  }
  return null;
}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Clock seam: keeps the component body free of direct impure calls. */
function nowMs(): number {
  return Date.now();
}

function engineAvailability(
  probes: Awaited<ReturnType<typeof probeNarrationEngines>> | undefined,
  id: RenditionEngine,
): EngineAvailability | null {
  if (!probes) return null;
  return probes[id];
}

function modelStatus(record: NarrationEngineRecord | undefined): {
  label: string;
  own: string | null;
} {
  if (!record) return { label: 'Not downloaded', own: null };
  if (record.status === 'ready') return { label: 'Ready', own: null };
  if (record.status === 'downloading') return { label: `Downloading ${Math.round(record.progress * 100)}%`, own: null };
  if (record.status === 'failed') {
    if (record.error === 'needs_extraction' || record.error === 'extraction_unavailable') {
      return { label: 'Needs extraction', own: 'needs_extraction' };
    }
    return { label: record.error ? `Failed · ${record.error}` : 'Failed', own: null };
  }
  return { label: 'Not downloaded', own: null };
}

/**
 * Import a directory the user extracted outside the app. The system picker
 * grants read access for this session; files are copied into the model folder.
 */
async function importModelFolder(bundle: ModelBundle): Promise<void> {
  const picked = await Directory.pickDirectoryAsync();
  const target = new Directory(Paths.document, modelDirFor(bundle));
  if (target.exists) target.delete();
  target.create({ intermediates: true });

  let copied = 0;
  const copyInto = async (source: Directory, relative: string): Promise<void> => {
    for (const entry of source.list()) {
      if (copied >= 500) return;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry instanceof Directory) {
        const child = new Directory(target, next);
        child.create({ intermediates: true });
        await copyInto(entry, next);
      } else {
        const destination = new File(target, next);
        await entry.copy(destination);
        copied += 1;
      }
    }
  };
  await copyInto(picked, '');
}

function bundleFailureCopy(result: BundleResult): string {
  if (result.status === 'ready') return '';
  if (result.error === 'needs_extraction' || result.error === 'extraction_unavailable') {
    return "This build can't unpack the model. Import an extracted folder, or install a build with the local voice engine.";
  }
  if (result.error === 'archive_not_found') {
    return 'The downloaded archive could not be found for extraction. Download it again.';
  }
  if (result.error === 'extraction_failed') {
    return 'The model archive could not be unpacked. Try downloading it again.';
  }
  if (result.error === 'download_incomplete') {
    return 'The download did not match the published size, so it was removed. Try again on a stable connection.';
  }
  if (result.missing?.length) return `The model folder is missing ${result.missing[0]}.`;
  return result.error ?? 'The model operation did not finish.';
}

export default function SettingsScreen() {
  const { palette } = useTheme();
  useDatabase();
  const prefs = usePreferences();
  const [aiOpen, setAiOpen] = useState(false);
  const [narrationOpen, setNarrationOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(prefs.aiBaseUrl);
  const [model, setModel] = useState(prefs.aiModel);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyState, setKeyState] = useState<'unknown' | 'present' | 'absent'>('unknown');
  const [actionError, setActionError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [testState, setTestState] = useState<
    { kind: 'idle' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string }
  >({ kind: 'idle' });
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmModel, setConfirmModel] = useState<ModelBundle | null>(null);
  const [modelBusy, setModelBusy] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<Record<string, number>>({});
  const [modelError, setModelError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const preset = getPreset(prefs.aiPreset || DEFAULT_PRESET_ID);
  const urlError = validateBaseUrl(baseUrl);
  const style = getNarrationStyle(prefs.narrationStyle);
  const kokoroBundle = MODEL_BUNDLES.find((bundle) => bundle.engine === 'kokoro');
  const kokoroSpeakers = kokoroBundle?.speakers ?? 1;
  const kokoroSpeaker = Math.min(
    kokoroSpeakers - 1,
    Math.max(0, prefs.narrationKokoroSpeaker ?? style.kokoroSpeakerId),
  );

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

  const engines = useAsync(async () => {
    const [probes, records] = await Promise.all([probeNarrationEngines(), listNarrationEngines()]);
    return { probes, records };
  }, [tick, narrationOpen]);

  const records = new Map((engines.data?.records ?? []).map((record) => [record.id, record]));

  const selectPreset = (id: string) => {
    const next = getPreset(id);
    prefs.setAiPreset(next.id);
    setBaseUrl(next.baseUrl);
    setModel(next.defaultModel);
    setAiError(null);
    setTestState({ kind: 'idle' });
  };

  const saveAi = async () => {
    setBusy('ai');
    setAiError(null);
    if (prefs.aiProvider === 'openai-compatible' && urlError) {
      setAiError(urlError);
      setBusy(null);
      return;
    }
    try {
      prefs.setAiPreset(preset.id);
      prefs.setAiBaseUrl(stripTrailingSlash(baseUrl));
      prefs.setAiModel(model.trim());
      if (keyDraft.trim()) await setStoredKey(keyDraft.trim());
      setKeyDraft('');
      setKeyState((await getStoredKey()) ? 'present' : 'absent');
      setAiOpen(false);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const canTest =
    prefs.aiProvider === 'openai-compatible' &&
    !urlError &&
    !!model.trim() &&
    (!preset.requiresKey || keyState === 'present' || !!keyDraft.trim());

  const testConnection = async () => {
    if (!canTest) {
      setTestState({
        kind: 'error',
        text: preset.requiresKey ? 'Add a key before testing this provider.' : 'Set a base URL and model first.',
      });
      return;
    }
    setTesting(true);
    setTestState({ kind: 'idle' });
    const started = nowMs();
    try {
      const savedKey = keyDraft.trim() ? keyDraft.trim() : (await getStoredKey()) ?? '';
      const provider = new OpenAiCompatibleProvider({
        baseUrl: stripTrailingSlash(baseUrl),
        model: model.trim() || preset.defaultModel,
        apiKey: savedKey,
        presetId: preset.id,
        responseFormat: prefs.aiResponseFormat === 'none' ? 'prompt_only' : prefs.aiResponseFormat,
        timeoutMs: 20_000,
      });
      const response = await provider.generate({
        task: 'takeaways',
        sources: TEST_SOURCES.map((source) => ({ ...source })),
        timeoutMs: 20_000,
        maxOutputTokens: 200,
      });
      const elapsed = nowMs() - started;
      if (response.degraded) {
        const reason =
          /Remote model unavailable \((.*?)\)\. Showing/s.exec(response.text)?.[1] ??
          'The provider did not answer.';
        setTestState({ kind: 'error', text: reason });
      } else {
        setTestState({
          kind: 'ok',
          text: `OK · ${response.strategy ?? 'auto'} · ${elapsed} ms`,
        });
      }
    } catch (e) {
      setTestState({ kind: 'error', text: (e as Error).message });
    } finally {
      setTesting(false);
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

  const toggleGenerationNotifications = async (enabled: boolean) => {
    setActionError(null);
    try {
      if (!enabled) {
        prefs.setGenerationNotifications(false);
        return;
      }
      const permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) {
        setActionError('Notifications are blocked in system settings.');
        return;
      }
      prefs.setGenerationNotifications(true);
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

  const downloadModel = async (bundle: ModelBundle) => {
    setModelBusy(bundle.id);
    setModelError(null);
    setModelProgress((progress) => ({ ...progress, [bundle.id]: 0 }));
    try {
      await upsertNarrationEngine({
        id: bundle.id,
        engine: bundle.engine,
        label: bundle.label,
        bundleUrl: bundle.url,
        bundleBytes: bundle.expectedBytes,
        status: 'downloading',
        progress: 0,
      });
      const result = await downloadBundle(bundle, defaultModelDeps(), {
        onProgress: (bytes) => {
          if (bytes) {
            setModelProgress((progress) => ({
              ...progress,
              [bundle.id]: Math.min(0.9, (0.9 * bytes) / bundle.expectedBytes),
            }));
          }
        },
        onExtractProgress: (event) => {
          setModelProgress((progress) => ({
            ...progress,
            [bundle.id]: Math.min(0.99, 0.9 + event.percent / 1000),
          }));
        },
      });
      const ready = result.status === 'ready';
      await updateNarrationEngine(bundle.id, {
        status: ready ? 'ready' : 'failed',
        progress: ready ? 1 : 0,
        modelDir: ready ? result.modelDir : null,
        verifiedAt: ready ? nowMs() : null,
        error: ready ? null : result.error ?? 'failed',
      });
      invalidateNarrationProbes();
      if (!ready) setModelError(bundleFailureCopy(result));
      setTick((t) => t + 1);
    } catch (e) {
      await updateNarrationEngine(bundle.id, { status: 'failed', progress: 0, error: 'failed' }).catch(
        () => {},
      );
      setModelError((e as Error).message);
      setTick((t) => t + 1);
    } finally {
      setModelBusy(null);
    }
  };

  const verifyModel = async (bundle: ModelBundle) => {
    setModelBusy(bundle.id);
    setModelError(null);
    try {
      const result = await reverifyInstalled(bundle, defaultModelDeps());
      const ready = result.status === 'ready';
      await updateNarrationEngine(bundle.id, {
        status: ready ? 'ready' : result.status === 'absent' ? 'absent' : 'failed',
        progress: ready ? 1 : 0,
        modelDir: ready ? result.modelDir : null,
        verifiedAt: ready ? nowMs() : null,
        error: ready ? null : result.error ?? null,
      });
      invalidateNarrationProbes();
      if (!ready) setModelError(bundleFailureCopy(result));
      setTick((t) => t + 1);
    } catch (e) {
      setModelError((e as Error).message);
    } finally {
      setModelBusy(null);
    }
  };

  const importFolder = async (bundle: ModelBundle) => {
    setModelBusy(bundle.id);
    setModelError(null);
    try {
      await importModelFolder(bundle);
      const result = await reverifyInstalled(bundle, defaultModelDeps());
      const ready = result.status === 'ready';
      await updateNarrationEngine(bundle.id, {
        status: ready ? 'ready' : 'failed',
        progress: ready ? 1 : 0,
        modelDir: ready ? result.modelDir : null,
        verifiedAt: ready ? nowMs() : null,
        error: ready ? null : result.error ?? 'failed',
      });
      invalidateNarrationProbes();
      if (!ready) setModelError(bundleFailureCopy(result));
      setTick((t) => t + 1);
    } catch (e) {
      setModelError((e as Error).message);
    } finally {
      setModelBusy(null);
    }
  };

  const removeModel = async (bundle: ModelBundle) => {
    setModelBusy(bundle.id);
    setModelError(null);
    try {
      await deleteBundle(bundle, defaultModelDeps());
      await deleteNarrationEngine(bundle.id).catch(() => {});
      invalidateNarrationProbes();
      setConfirmModel(null);
      setTick((t) => t + 1);
    } catch (e) {
      setModelError((e as Error).message);
    } finally {
      setModelBusy(null);
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
      <Card onPress={() => setNarrationOpen(true)} style={{ paddingVertical: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name="headset-outline" size={18} color={palette.accent} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodySm" style={{ fontWeight: '600' }}>
              Narration
            </AppText>
            <AppText variant="caption" faint>
              {NARRATION_LANGUAGES.find((l) => l.id === prefs.narrationLanguage)?.label ?? prefs.narrationLanguage} ·{' '}
              {prefs.narrationRate}× · {style.label} · {prefs.narrationLength} min
            </AppText>
          </View>
          <Icon name="chevron-forward" size={16} color={palette.inkFaint} />
        </View>
      </Card>

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

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <AppText variant="bodySm" style={{ fontWeight: '600' }}>
            Generation notifications
          </AppText>
          <AppText variant="caption" faint>
            One local notification when a narration finishes. It only fires while the app is alive; background
            compute is not implemented.
          </AppText>
        </View>
        <Switch
          value={prefs.generationNotifications}
          onValueChange={(value) => void toggleGenerationNotifications(value)}
          trackColor={{ true: palette.accent, false: palette.line }}
          thumbColor={palette.surface}
        />
      </View>

      <Divider />
      <AppText variant="label" muted>
        AI provider
      </AppText>
      <Card onPress={() => setAiOpen(true)} style={{ paddingVertical: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name={prefs.aiProvider === 'local' ? 'phone-portrait-outline' : 'cloud-outline'} size={18} color={palette.accent} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodySm" style={{ fontWeight: '600' }}>
              {prefs.aiProvider === 'local' ? 'On-device extractive' : `${preset.label} · ${prefs.aiModel || 'not configured'}`}
            </AppText>
            <AppText variant="caption" faint>
              {prefs.aiProvider === 'local'
                ? 'No key, no network. Answers are extracted from your own text.'
                : keyState === 'present'
                  ? 'Key stored in the device keychain.'
                  : preset.requiresKey
                    ? 'No key saved yet.'
                    : 'No key needed for this endpoint.'}
            </AppText>
          </View>
          <Icon name="chevron-forward" size={16} color={palette.inkFaint} />
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
            Narration audio
          </AppText>
          <AppText variant="caption">{formatBytes(usage.data?.storage.narrationBytes ?? 0)}</AppText>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
          <AppText variant="caption" muted>
            Local voices
          </AppText>
          <AppText variant="caption">{formatBytes(usage.data?.storage.modelBytes ?? 0)}</AppText>
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
      <BrandLockup height={40} />
      <AppText variant="caption" faint>
        Freehaven 0.1.0 · open source, local-first. No accounts, no ads, no telemetry. Public-domain texts come from
        Project Gutenberg under its terms.
      </AppText>

      <Sheet visible={narrationOpen} onClose={() => setNarrationOpen(false)} title="Narration">
        <AppText variant="label" muted>
          Engine
        </AppText>
        <View style={{ gap: space.sm }}>
          {ENGINE_ROWS.map((row) => {
            const availability = engineAvailability(engines.data?.probes, row.id);
            const reason = availability && !availability.available ? REASON_COPY[availability.reason] : null;
            const selected = prefs.narrationEngine === row.id;
            return (
              <Card key={row.id} style={{ paddingVertical: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Icon
                    name={row.id === 'device' ? 'phone-portrait-outline' : row.id === 'remote' ? 'cloud-outline' : 'server-outline'}
                    size={18}
                    color={selected ? palette.accent : palette.inkMuted}
                  />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                      {row.label}
                    </AppText>
                    <AppText variant="caption" faint>
                      {reason ?? row.blurb}
                    </AppText>
                  </View>
                  {availability?.available ? (
                    <Chip label={selected ? 'Selected' : 'Use'} active={selected} onPress={() => prefs.setNarrationEngine(row.id)} />
                  ) : availability ? (
                    <AppText variant="caption" faint>
                      Unavailable
                    </AppText>
                  ) : (
                    <AppText variant="caption" faint>
                      Checking…
                    </AppText>
                  )}
                </View>
              </Card>
            );
          })}
        </View>

        <Divider />
        <AppText variant="label" muted>
          Local voices
        </AppText>
        <View style={{ gap: space.sm }}>
          {MODEL_BUNDLES.map((bundle) => {
            const record = records.get(bundle.id);
            const status = modelStatus(record);
            const progress = modelProgress[bundle.id] ?? record?.progress ?? 0;
            const busyRow = modelBusy === bundle.id;
            return (
              <Card key={bundle.id} style={{ paddingVertical: space.md }}>
                <View style={{ gap: 4 }}>
                  <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                    {bundle.label}
                  </AppText>
                  <AppText variant="caption" faint>
                    {formatBytes(bundle.expectedBytes)} · {bundle.license}
                  </AppText>
                  <AppText variant="caption" muted>
                    {status.label}
                    {bundle.id === 'kokoro-int8-multi-lang-v1_1' ? ' · 103 voices, slow on mid-range phones' : ''}
                  </AppText>
                  {status.own === 'needs_extraction' || progress > 0 ? (
                    <View style={{ marginTop: 4, gap: 4 }}>
                      <View
                        style={{
                          height: 4,
                          borderRadius: 2,
                          backgroundColor: palette.surfaceAlt,
                          overflow: 'hidden',
                        }}
                      >
                        <View
                          style={{
                            width: `${Math.max(0, Math.min(1, status.label === 'Ready' ? 1 : progress)) * 100}%`,
                            height: 4,
                            backgroundColor: palette.accent,
                          }}
                        />
                      </View>
                    </View>
                  ) : null}
                  {status.own === 'needs_extraction' ? (
                    <AppText variant="caption" faint>
                      This build cannot unpack the model. Import an extracted folder, or install a build with the local
                      voice engine.
                    </AppText>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: space.sm }}>
                    <Button
                      label={record?.status === 'ready' ? 'Re-download' : 'Download'}
                      size="sm"
                      variant="secondary"
                      loading={busyRow}
                      disabled={!!modelBusy}
                      onPress={() => void downloadModel(bundle)}
                    />
                    <Button
                      label="Verify"
                      size="sm"
                      variant="secondary"
                      loading={busyRow}
                      disabled={!!modelBusy}
                      onPress={() => void verifyModel(bundle)}
                    />
                    <Button
                      label="Import folder"
                      size="sm"
                      variant="ghost"
                      disabled={!!modelBusy}
                      onPress={() => void importFolder(bundle)}
                    />
                    <Button
                      label="Delete"
                      size="sm"
                      variant="danger"
                      disabled={!!modelBusy || record?.status === 'absent'}
                      onPress={() => setConfirmModel(bundle)}
                    />
                  </View>
                </View>
              </Card>
            );
          })}
        </View>
        {modelError ? (
          <AppText variant="caption" color={palette.danger}>
            {modelError}
          </AppText>
        ) : null}

        <Divider />
        <AppText variant="label" muted>
          Style
        </AppText>
        <View style={{ gap: space.sm }}>
          {NARRATION_STYLES.map((option) => {
            const selected = prefs.narrationStyle === option.id;
            return (
              <Card key={option.id} onPress={() => prefs.setNarrationStyle(option.id)} style={{ paddingVertical: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Icon name="sparkles-outline" size={16} color={selected ? palette.accent : palette.inkFaint} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                      {option.label}
                    </AppText>
                    <AppText variant="caption" faint>
                      {option.persona}
                    </AppText>
                  </View>
                  {selected ? (
                    <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
                      Selected
                    </AppText>
                  ) : null}
                </View>
              </Card>
            );
          })}
        </View>

        <AppText variant="label" muted>
          Length
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {LENGTH_PRESETS.map((option) => (
            <Chip
              key={option.id}
              label={`${option.minutes} min · ${option.words.toLocaleString()} words`}
              active={prefs.narrationLength === option.id}
              onPress={() => prefs.setNarrationLength(option.id)}
            />
          ))}
        </View>

        <AppText variant="label" muted>
          Speed
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {[0.75, 1, 1.25, 1.5].map((rate) => (
            <Chip key={rate} label={`${rate}×`} active={prefs.narrationRate === rate} onPress={() => prefs.setNarrationRate(rate)} />
          ))}
        </View>

        <Field
          label="Instruction (optional)"
          value={prefs.narrationInstruction}
          onChangeText={(value) => prefs.setNarrationInstruction(value.slice(0, MAX_INSTRUCTION_CHARS))}
          placeholder="One sentence: pace, emphasis, who it is for…"
          maxLength={MAX_INSTRUCTION_CHARS}
          hint={`${prefs.narrationInstruction.length}/${MAX_INSTRUCTION_CHARS} · Applies to the script, not the voice. Keep it to one sentence.`}
        />

        <AppText variant="label" muted>
          Language
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

        {prefs.narrationEngine === 'kokoro' ? (
          <View style={{ gap: space.sm }}>
            <Divider />
            <AppText variant="label" muted>
              Kokoro voice
            </AppText>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Button
                label="−"
                size="sm"
                variant="secondary"
                disabled={kokoroSpeaker <= 0}
                onPress={() =>
                  prefs.setNarrationKokoroSpeaker(Math.max(0, kokoroSpeaker - 1))
                }
              />
              <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                {kokoroSpeaker}
              </AppText>
              <Button
                label="+"
                size="sm"
                variant="secondary"
                disabled={kokoroSpeaker >= kokoroSpeakers - 1}
                onPress={() =>
                  prefs.setNarrationKokoroSpeaker(
                    Math.min(kokoroSpeakers - 1, kokoroSpeaker + 1),
                  )
                }
              />
              <AppText variant="caption" faint>
                0–{kokoroSpeakers - 1}
              </AppText>
              {prefs.narrationKokoroSpeaker !== null ? (
                <Chip
                  label="Style default"
                  active={false}
                  onPress={() => prefs.setNarrationKokoroSpeaker(null)}
                />
              ) : null}
            </View>
            <AppText variant="caption" faint>
              {kokoroBundle && records.get(kokoroBundle.id)?.status === 'ready'
                ? `Speaker ${kokoroSpeaker} of ${kokoroSpeakers}.`
                : 'Download the Kokoro model below before narrating with this voice.'}
            </AppText>
          </View>
        ) : null}

        {prefs.narrationEngine === 'remote' ? (
          <View style={{ gap: space.sm }}>
            <Divider />
            <AppText variant="label" muted>
              Remote voice
            </AppText>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Field label="Speech model" value={prefs.speechModel} onChangeText={prefs.setSpeechModel} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Voice" value={prefs.speechVoice} onChangeText={prefs.setSpeechVoice} autoCapitalize="none" />
              </View>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {REMOTE_VOICES.map((voice) => (
                <Chip key={voice} label={voice} active={prefs.speechVoice === voice} onPress={() => prefs.setSpeechVoice(voice)} />
              ))}
            </View>
            <AppText variant="caption" faint>
              Delivery instructions are sent only to models that accept them (gpt-4o family).
            </AppText>
          </View>
        ) : null}

        <Divider />
        <AppText variant="caption" faint>
          Narration audio {formatBytes(usage.data?.storage.narrationBytes ?? 0)} · local voices{' '}
          {formatBytes(usage.data?.storage.modelBytes ?? 0)} · download cache{' '}
          {formatBytes(usage.data?.storage.cacheBytes ?? 0)}.
        </AppText>
        <AppText variant="caption" faint>
          Style changes what the script says; the device voice reads it at your chosen rate.
        </AppText>
      </Sheet>

      <Sheet visible={aiOpen} onClose={() => setAiOpen(false)} title="AI provider">
        <AppText variant="caption" muted>
          The on-device extractive engine always works and needs no key. A remote model is optional: Freehaven sends
          only the passages retrieved for your question, never the whole library.
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Chip label="On-device" active={prefs.aiProvider === 'local'} onPress={() => prefs.setAiProvider('local')} />
          <Chip
            label="Remote"
            active={prefs.aiProvider === 'openai-compatible'}
            onPress={() => prefs.setAiProvider('openai-compatible')}
          />
        </View>

        <AppText variant="label" muted>
          Provider
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {PRESETS.map((option) => (
            <Chip
              key={option.id}
              label={option.label}
              active={preset.id === option.id}
              onPress={() => selectPreset(option.id)}
            />
          ))}
        </View>
        {preset.notes ? (
          <AppText variant="caption" faint>
            {preset.notes}
          </AppText>
        ) : null}

        <Field
          label="Base URL"
          value={baseUrl}
          onChangeText={(value) => {
            setBaseUrl(value);
            setTestState({ kind: 'idle' });
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://api.openai.com/v1"
          hint={urlError ?? undefined}
        />
        <Field
          label="Model"
          value={model}
          onChangeText={(value) => {
            setModel(value);
            setTestState({ kind: 'idle' });
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={preset.defaultModel || 'model id'}
        />
        {preset.suggestedModels?.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {preset.suggestedModels.map((suggested) => (
              <Chip
                key={suggested.id}
                label={suggested.label}
                active={model === suggested.id}
                onPress={() => setModel(suggested.id)}
              />
            ))}
          </View>
        ) : null}

        <Field
          label={keyState === 'present' ? 'Replace API key (saved)' : 'API key'}
          value={keyDraft}
          onChangeText={setKeyDraft}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={preset.requiresKey ? 'sk-…' : 'Not needed for this endpoint'}
          hint="Stored in SecureStore / Keychain. Never shown, bundled or logged."
        />

        <AppText variant="label" muted>
          Response format
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {RESPONSE_FORMATS.map((format) => (
            <Chip
              key={format.id}
              label={format.label}
              active={prefs.aiResponseFormat === format.id}
              onPress={() => prefs.setAiResponseFormat(format.id)}
            />
          ))}
        </View>
        <AppText variant="caption" faint>
          Auto tries JSON schema, then JSON object, then plain text. The endpoint refusal is never fatal.
        </AppText>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Button
            label="Test connection"
            icon="pulse-outline"
            variant="secondary"
            size="sm"
            loading={testing}
            disabled={!canTest || testing}
            onPress={() => void testConnection()}
          />
          {!canTest ? (
            <AppText variant="caption" faint style={{ flex: 1 }}>
              {preset.requiresKey && keyState !== 'present' && !keyDraft.trim()
                ? 'Add a key first.'
                : urlError ?? 'Set a base URL and model first.'}
            </AppText>
          ) : null}
        </View>
        {testState.kind !== 'idle' ? (
          <AppText
            variant="caption"
            color={testState.kind === 'ok' ? palette.accent : palette.danger}
          >
            {testState.text}
          </AppText>
        ) : null}
        <AppText variant="caption" faint>
          The test sends two fixed one-sentence passages, never anything from your library.
        </AppText>

        <Button label="Save" onPress={() => void saveAi()} loading={busy === 'ai'} full />
        {aiError ? (
          <AppText variant="caption" color={palette.danger}>
            {aiError}
          </AppText>
        ) : null}
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

      <Sheet visible={!!confirmModel} onClose={() => setConfirmModel(null)} title="Delete this voice?">
        <AppText variant="bodySm" muted>
          {confirmModel
            ? `${confirmModel.label} will be removed from this device (${formatBytes(confirmModel.expectedBytes)}). Narrations that use it may need re-synthesis.`
            : ''}
        </AppText>
        <Button
          label="Delete voice model"
          variant="danger"
          full
          loading={!!confirmModel && modelBusy === confirmModel.id}
          onPress={() => confirmModel && void removeModel(confirmModel)}
        />
        <Button label="Cancel" variant="ghost" full onPress={() => setConfirmModel(null)} />
      </Sheet>
    </Screen>
  );
}
