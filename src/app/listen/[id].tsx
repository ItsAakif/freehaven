import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Speech from 'expo-speech';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Icon } from '@/design/icon';
import { BrandMark } from '@/design/brand';
import {
  Screen,
  AppText,
  Card,
  Button,
  Chip,
  Cover,
  Field,
  Header,
  IconButton,
  ProgressBar,
  Sheet,
  EmptyState,
  LoadingBlock,
  Divider,
} from '@/design/ui';
import { radius, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { getBook } from '@/data/repositories/books';
import { getDocument, listSections } from '@/data/repositories/reading';
import {
  getOrCreateRendition,
  getRenditionProgress,
  listRenditions,
  listSegments,
  replaceSegments,
  saveRenditionProgress,
  setRenditionEngine,
} from '@/data/repositories/renditions';
import { usePreferences } from '@/state/preferences';
import {
  planRenditionSegments,
} from '@/features/narration/generate';
import { NARRATION_STYLES, getNarrationStyle } from '@/features/narration/styles';
import { LENGTH_PRESETS } from '@/features/narration/lengths';
import { computeOffsets, estimatedDurationMs, locateInSegments, sectionMarkers } from '@/features/narration/manifest';
import { tokenizeTranscript, wordIndexForProgress, parseSpeechTimings, timingIndexForElapsed } from '@/features/narration/transcript';
import { maxCharsForEngine, planSpeechSegments } from '@/features/narration/segments';
import {
  probeNarrationEngines,
  type EngineAvailability,
  type EngineUnavailableReason,
} from '@/features/narration/engines';
import { instructionHash, MAX_INSTRUCTION_CHARS } from '@/features/narration/script';
import { NARRATION_LANGUAGES, voicesForLanguage, type DeviceVoice } from '@/features/audio';
import type { Rendition, RenditionEngine, RenditionSegment } from '@/domain/narration';

const RATES = [0.75, 1, 1.25, 1.5];

const ENGINE_LABEL: Record<RenditionEngine, string> = {
  device: 'Device voice',
  remote: 'Remote voice',
  piper: 'Piper (local)',
  kokoro: 'Kokoro (local)',
};

const REASON_COPY: Record<EngineUnavailableReason, string> = {
  not_installed: 'This build does not include the local voice engine.',
  no_model: 'No voice model is installed. Download one in Settings → Narration.',
  load_failed: 'The local voice engine could not start. Re-download the model or pick another engine.',
  model_absent: 'No voice model is downloaded. Add one in Settings → Narration.',
  model_unverified: 'The voice model is incomplete. Verify it in Settings → Narration.',
  needs_extraction: "This build can't unpack the model. Import an extracted folder in Settings.",
  no_key: 'Add a provider key in Settings → AI provider.',
  no_base_url: 'Set a provider base URL in Settings → AI provider.',
  unsupported_platform: 'This device does not support that engine.',
};

function reasonCopy(
  availability: EngineAvailability | null | undefined,
  fallback: EngineUnavailableReason = 'not_installed',
): string {
  return REASON_COPY[availability && !availability.available ? availability.reason : fallback];
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Script segments carry a heading only on their first piece; carry it forward. */
function sectionTitleForSegment(segments: RenditionSegment[], index: number): string {
  for (let cursor = Math.min(index, segments.length - 1); cursor >= 0; cursor -= 1) {
    const title = (segments[cursor]?.title ?? '').trim();
    if (title) return title;
  }
  return '';
}

type Loaded = {
  book: Awaited<ReturnType<typeof getBook>>;
  document: Awaited<ReturnType<typeof getDocument>>;
  rendition: Rendition | null;
  renditions: Rendition[];
  segments: RenditionSegment[];
  progress: Awaited<ReturnType<typeof getRenditionProgress>>;
  probes: Awaited<ReturnType<typeof probeNarrationEngines>>;
} | null;

export default function ListenScreen() {
  const { id, rendition: renditionParam, t } = useLocalSearchParams<{
    id: string;
    rendition?: string;
    t?: string;
  }>();
  const { palette } = useTheme();
  const narrationRate = usePreferences((s) => s.narrationRate);
  const setNarrationRate = usePreferences((s) => s.setNarrationRate);
  const narrationVoice = usePreferences((s) => s.narrationVoice);
  const setNarrationVoice = usePreferences((s) => s.setNarrationVoice);
  const language = usePreferences((s) => s.narrationLanguage);
  const setLanguage = usePreferences((s) => s.setNarrationLanguage);
  const defaultStyle = usePreferences((s) => s.narrationStyle);
  const defaultLength = usePreferences((s) => s.narrationLength);
  const defaultEngine = usePreferences((s) => s.narrationEngine);
  const instructionPref = usePreferences((s) => s.narrationInstruction);
  const speedModel = usePreferences((s) => s.speechModel);
  const speedVoice = usePreferences((s) => s.speechVoice);
  const setNarrationInstruction = usePreferences((s) => s.setNarrationInstruction);

  const [selectedRenditionId, setSelectedRenditionId] = useState<string | null>(renditionParam ?? null);
  const [tick, setTick] = useState(0);

  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  const [deviceElapsedMs, setDeviceElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [styleId, setStyleId] = useState(defaultStyle);
  const [length, setLength] = useState(defaultLength);
  const [engine, setEngine] = useState<RenditionEngine>(defaultEngine);
  const [instruction, setInstruction] = useState(instructionPref);
  const [engineSheet, setEngineSheet] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [sleepOpen, setSleepOpen] = useState(false);
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepLabel, setSleepLabel] = useState<string | null>(null);
  const [voices, setVoices] = useState<DeviceVoice[]>([]);

  const stopping = useRef(false);
  const speechSeq = useRef(0);
  const didInit = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const currentTimeRef = useRef(0);
  const deviceClock = useRef({ startedAt: 0, baseMs: 0 });
  const snapshotRef = useRef({ renditionId: null as string | null, positionMs: 0, index: 0 });

  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  const state = useAsync<Loaded>(async () => {
    const book = await getBook(id);
    if (!book) return null;
    const [document, renditions] = await Promise.all([getDocument(book.id), listRenditions(book.id)]);
    const chosen =
      (selectedRenditionId ? findRendition(renditions, selectedRenditionId) : null) ??
      renditions.find((candidate) => candidate.status !== 'draft') ??
      renditions[0] ??
      null;
    const [segments, progress, probes] = await Promise.all([
      chosen ? listSegments(chosen.id) : Promise.resolve([]),
      chosen ? getRenditionProgress(chosen.id) : Promise.resolve(null),
      probeNarrationEngines(),
    ]);
    return { book, document, rendition: chosen, renditions, segments, progress, probes };
  }, [id, tick, selectedRenditionId]);

  useEffect(() => {
    void Speech.getAvailableVoicesAsync()
      .then((available) =>
        setVoices(
          available.map((voice) => ({
            identifier: voice.identifier,
            name: voice.name,
            language: voice.language,
            quality: voice.quality,
          })),
        ),
      )
      .catch(() => setVoices([]));
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {});
    return () => {
      stopping.current = true;
      void Speech.stop();
    };
  }, []);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    currentTimeRef.current = status.currentTime ?? 0;
  }, [status.currentTime]);

  useEffect(() => {
    if (!sleepUntil) return;
    const timer = setTimeout(() => {
      void Speech.stop();
      player.pause();
      setPlaying(false);
      setSleepUntil(null);
      setSleepLabel(null);
    }, Math.max(0, sleepUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [sleepUntil, player]);

  const rendition = state.data?.rendition ?? null;
  const segments = useMemo(() => state.data?.segments ?? [], [state.data?.segments]);
  const mode: 'device' | 'file' = rendition?.engine === 'device' ? 'device' : 'file';

  // Device narration has no native clock, so approximate elapsed time while speaking.
  useEffect(() => {
    if (mode !== 'device' || !playing) return;
    const timer = setInterval(() => {
      setDeviceElapsedMs(deviceClock.current.baseMs + (Date.now() - deviceClock.current.startedAt));
    }, 200);
    return () => clearInterval(timer);
  }, [mode, playing]);

  const starts = useMemo(
    () => computeOffsets(segments.map((segment) => ({ durationMs: segment.durationMs, text: segment.text }))),
    [segments],
  );
  const totalMs = useMemo(() => {
    if (!segments.length) return rendition?.durationMs ?? 0;
    const last = segments[segments.length - 1];
    return starts[starts.length - 1] + (last.durationMs ?? estimatedDurationMs(last.text));
  }, [segments, starts, rendition?.durationMs]);

  const markers = useMemo(
    () => sectionMarkers(segments.map((segment, i) => ({ startMs: starts[i] ?? 0, title: segment.title, sectionId: segment.sectionId }))),
    [segments, starts],
  );

  useEffect(() => {
    if (!rendition?.id || !segments.length) return;
    if (didInit.current === rendition.id) return;
    didInit.current = rendition.id;
    const routePosition = t !== undefined ? Number(t) : undefined;
    const target =
      routePosition !== undefined && Number.isFinite(routePosition)
        ? routePosition
        : state.data?.progress?.positionMs ?? 0;
    const loc = locateInSegments(
      segments.map((segment, i) => ({ startMs: starts[i] ?? 0, durationMs: segment.durationMs, text: segment.text })),
      target,
    );
    setIndex(Math.max(0, loc.index));
    setPositionMs(Math.max(0, target));
    pendingSeekRef.current = loc.offsetMs;
  }, [rendition?.id, segments, starts, state.data?.progress?.positionMs, t]);

  useEffect(() => {
    if (index < segments.length) return;
    setIndex(0);
  }, [index, segments.length]);

  const persist = useCallback(
    (targetIndex: number, targetPositionMs: number, completed = false) => {
      if (!rendition?.id) return;
      void saveRenditionProgress({
        renditionId: rendition.id,
        positionMs: Math.max(0, targetPositionMs),
        percent: totalMs > 0 ? Math.min(1, targetPositionMs / totalMs) : 0,
        completed,
      });
    },
    [rendition?.id, totalMs],
  );

  useEffect(() => {
    snapshotRef.current = { renditionId: rendition?.id ?? null, positionMs, index };
  }, [rendition?.id, positionMs, index]);

  useEffect(
    () => () => {
      const snapshot = snapshotRef.current;
      if (!snapshot.renditionId) return;
      void saveRenditionProgress({
        renditionId: snapshot.renditionId,
        positionMs: snapshot.positionMs,
        percent: totalMs > 0 ? Math.min(1, snapshot.positionMs / totalMs) : 0,
        completed: false,
      });
    },
    [totalMs],
  );

  function nextReady(from: number): number | null {
    for (let candidate = from + 1; candidate < segments.length; candidate += 1) {
      if (canPlay(segments[candidate])) return candidate;
    }
    return null;
  }

  function firstReady(from = 0): number | null {
    for (let candidate = from; candidate < segments.length; candidate += 1) {
      if (canPlay(segments[candidate])) return candidate;
    }
    return null;
  }

  function canPlay(segment: RenditionSegment | undefined): boolean {
    if (!segment || segment.status !== 'ready') return false;
    return mode === 'device' ? true : !!segment.filePath;
  }

  /* ------------------------------------------------------------ file playback */

  useEffect(() => {
    if (mode !== 'file' || !segments.length) return;
    const segment = segments[index];
    if (!segment?.filePath) return;
    let cancelled = false;
    void (async () => {
      player.pause();
      if (cancelled) return;
      player.replace({ uri: segment.filePath as string });
      player.setPlaybackRate(1);
      player.setActiveForLockScreen(true, {
        title: segment.title ?? state.data?.book?.title ?? 'Freehaven',
        artist: 'Freehaven',
        albumTitle: state.data?.book?.title ?? 'Freehaven',
      });
      const seek = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (seek != null) await player.seekTo(seek / 1000);
      if (playingRef.current && !cancelled) player.play();
    })();
    return () => {
      cancelled = true;
    };
  }, [index, mode, segments, player, state.data?.book?.title]);

  useEffect(() => {
    if (mode !== 'file' || !status.didJustFinish) return;
    const next = nextReady(index);
    if (next == null) {
      setPlaying(false);
      setPositionMs(totalMs);
      persist(index, totalMs, true);
      return;
    }
    setIndex(next);
    persist(next, starts[next] ?? 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.didJustFinish]);

  useEffect(() => {
    if (!playing || mode !== 'file' || !rendition?.id) return;
    const timer = setInterval(() => {
      const absolute = (starts[index] ?? 0) + currentTimeRef.current * 1000;
      setPositionMs(absolute);
      void saveRenditionProgress({
        renditionId: rendition.id,
        positionMs: absolute,
        percent: totalMs > 0 ? Math.min(1, absolute / totalMs) : 0,
        completed: false,
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, [playing, mode, rendition?.id, starts, index, totalMs]);

  /* ---------------------------------------------------------- device playback */

  function speakSegment(targetIndex: number) {
    const segment = segments[targetIndex];
    if (!segment) {
      setPlaying(false);
      return;
    }
    const sequence = speechSeq.current + 1;
    speechSeq.current = sequence;
    stopping.current = false;
    deviceClock.current = { startedAt: Date.now(), baseMs: 0 };
    setDeviceElapsedMs(0);
    setIndex(targetIndex);
    setPlaying(true);

    const pieces = planSpeechSegments(segment.text, maxCharsForEngine('device'));
    const advance = () => {
      if (sequence !== speechSeq.current || stopping.current) return;
      const next = nextReady(targetIndex);
      if (next == null) {
        setPlaying(false);
        persist(targetIndex, totalMs, true);
        return;
      }
      speakSegment(next);
    };
    const speakPiece = (pieceIndex: number) => {
      if (sequence !== speechSeq.current || stopping.current) return;
      const piece = pieces[pieceIndex];
      if (!piece) {
        advance();
        return;
      }
      Speech.speak(piece.text, {
        rate: narrationRate,
        language,
        voice: narrationVoice ?? undefined,
        onDone: () => {
          if (sequence !== speechSeq.current || stopping.current) return;
          if (pieceIndex + 1 < pieces.length) speakPiece(pieceIndex + 1);
          else advance();
        },
        onError: () => setPlaying(false),
      });
    };
    speakPiece(0);
  }

  /* --------------------------------------------------------------- generation */

  const openGeneration = (target?: Rendition) => {
    const id = target?.id ?? rendition?.id;
    if (!id) return;
    router.push({
      pathname: '/generate/[renditionId]',
      params: { renditionId: id },
    });
  };

  const createNarration = async () => {
    if (!state.data?.book) return;
    setError(null);
    try {
      const chosenStyle = getNarrationStyle(styleId);
      const created = await getOrCreateRendition({
        bookId: state.data.book.id,
        language,
        styleId: chosenStyle.id,
        length,
      });
      const cleanInstruction = instruction.trim().slice(0, MAX_INSTRUCTION_CHARS);
      await setRenditionEngine(created.id, {
        engine,
        voice: chosenStyle.defaultVoices[engine] ?? null,
        model: engine === 'remote' ? speedModel : null,
        instruction: cleanInstruction || null,
        instructionHash: instructionHash(cleanInstruction),
        status: 'draft',
      });
      setSelectedRenditionId(created.id);
      openGeneration({ ...created, engine, instruction: cleanInstruction || null });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const changeEngine = async (nextEngine: RenditionEngine) => {
    if (!rendition) return;
    setEngineSheet(false);
    setError(null);
    setNotice(null);
    try {
      const style = getNarrationStyle(rendition.styleId);
      const updated: Rendition = {
        ...rendition,
        engine: nextEngine,
        voice: style.defaultVoices[nextEngine] ?? null,
        model: nextEngine === 'remote' ? speedModel : rendition.model,
      };
      await setRenditionEngine(rendition.id, {
        engine: nextEngine,
        voice: updated.voice,
        model: updated.model,
        instruction: rendition.instruction,
        instructionHash: rendition.instructionHash,
        status: rendition.scriptMd ? 'script_ready' : 'draft',
      });
      if (rendition.scriptMd && state.data?.document) {
        const sections = await listSections(state.data.document.id);
        const planned = planRenditionSegments({
          rendition: updated,
          script: rendition.scriptMd,
          sections: sections.map((section) => ({ id: section.id, title: section.title ?? null })),
        });
        await replaceSegments(rendition.id, planned);
      }
      setTick((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /* ------------------------------------------------------------------ controls */

  const toggle = async () => {
    if (!rendition) return;
    if (mode === 'device') {
      if (playing) {
        stopping.current = true;
        speechSeq.current += 1;
        await Speech.stop();
        setPlaying(false);
        persist(index, starts[index] ?? 0, false);
      } else {
        speakSegment(segments[index]?.status === 'ready' ? index : firstReady(index) ?? 0);
      }
      return;
    }
    if (playing) {
      player.pause();
      setPlaying(false);
      persist(index, (starts[index] ?? 0) + currentTimeRef.current * 1000, false);
      return;
    }
    const targetIndex = segments[index]?.status === 'ready' ? index : firstReady(index);
    if (targetIndex == null) {
      setNotice('Generate audio to continue.');
      return;
    }
    if (targetIndex !== index) {
      setIndex(targetIndex);
      pendingSeekRef.current = 0;
      setPlaying(true);
      return;
    }
    player.play();
    setPlaying(true);
  };

  const seek = (deltaMs: number) => {
    if (!segments.length) return;
    const absolute = Math.max(
      0,
      Math.min(totalMs, (starts[index] ?? 0) + currentTimeRef.current * 1000 + deltaMs),
    );
    const loc = locateInSegments(
      segments.map((segment, i) => ({ startMs: starts[i] ?? 0, durationMs: segment.durationMs, text: segment.text })),
      absolute,
    );
    setPositionMs(absolute);
    if (mode === 'device') {
      if (playing) {
        stopping.current = true;
        speechSeq.current += 1;
        void Speech.stop();
        setTimeout(() => speakSegment(Math.max(0, loc.index)), 120);
      } else {
        setIndex(Math.max(0, loc.index));
      }
      return;
    }
    if (loc.index !== index) {
      setIndex(Math.max(0, loc.index));
      pendingSeekRef.current = loc.offsetMs;
    } else {
      void player.seekTo(loc.offsetMs / 1000);
    }
    persist(Math.max(0, loc.index), absolute, false);
  };

  const jumpToSegment = (targetIndex: number) => {
    if (targetIndex < 0 || targetIndex >= segments.length) return;
    stopping.current = true;
    speechSeq.current += 1;
    void Speech.stop();
    player.pause();
    setPlaying(false);
    setIndex(targetIndex);
    setPositionMs(starts[targetIndex] ?? 0);
    pendingSeekRef.current = 0;
    persist(targetIndex, starts[targetIndex] ?? 0, false);
    setChaptersOpen(false);
  };

  const changeLanguage = (next: string) => {
    setLanguage(next);
    const available = voicesForLanguage(voices, next);
    const current = available.find((voice) => voice.identifier === narrationVoice);
    if (!current) setNarrationVoice(available[0]?.identifier ?? null);
  };

  /* -------------------------------------------------------------------- views */

  if (state.loading) {
    return (
      <Screen>
        <Header title="Listen" onBack={() => router.back()} />
        <LoadingBlock label="Preparing narration…" />
      </Screen>
    );
  }

  if (!state.data?.book) {
    return (
      <Screen>
        <Header title="Listen" onBack={() => router.back()} />
        <EmptyState icon="alert-circle-outline" title="Book not found" body="It may have been removed from your library." />
      </Screen>
    );
  }

  const { book, document, probes } = state.data;

  if (!document) {
    return (
      <Screen>
        <Header title="Listen" subtitle={book.title} onBack={() => router.back()} />
        <EmptyState
          icon="headset-outline"
          title="Narration needs extracted text"
          body="Import a book or download a public-domain edition first. Narration is written from the text already on this device."
        />
      </Screen>
    );
  }

  if (!rendition) {
    const availableEngines = (['device', 'remote', 'piper', 'kokoro'] as const).filter(
      (candidate) => probes[candidate]?.available,
    );
    const styles = NARRATION_STYLES;
    const selectedStyle = getNarrationStyle(styleId);
    return (
      <Screen>
        <Header title="Create narration" subtitle={book.title} onBack={() => router.back()} />
        <AppText variant="bodySm" muted>
          A narration is written from this book, then spoken. Choose a style and length; you decide later when to
          generate audio.
        </AppText>

        <AppText variant="label" muted>
          Style
        </AppText>
        <View style={{ gap: space.sm }}>
          {styles.map((option) => {
            const selected = option.id === styleId;
            return (
              <Card
                key={option.id}
                onPress={() => {
                  setStyleId(option.id);
                  setLength(option.defaultLength);
                }}
                style={{ paddingVertical: space.md }}
              >
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
              active={length === option.id}
              onPress={() => setLength(option.id)}
            />
          ))}
        </View>

        <AppText variant="label" muted>
          Voice engine
        </AppText>
        <View style={{ gap: space.sm }}>
          {(['device', 'remote', 'piper', 'kokoro'] as const).map((candidate) => {
            const availability = probes[candidate];
            const available = availability?.available ?? false;
            const selected = engine === candidate;
            return (
              <Card key={candidate} style={{ paddingVertical: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Icon
                    name={candidate === 'device' ? 'phone-portrait-outline' : candidate === 'remote' ? 'cloud-outline' : 'server-outline'}
                    size={18}
                    color={selected ? palette.accent : palette.inkMuted}
                  />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                      {ENGINE_LABEL[candidate]}
                    </AppText>
                    <AppText variant="caption" faint>
                      {available
                        ? candidate === 'device'
                          ? 'Offline. Reads the script at your chosen rate.'
                          : candidate === 'remote'
                            ? `Audio files from ${speedModel} · ${speedVoice}.`
                            : availability?.detail ?? 'Local neural voice.'
                        : reasonCopy(availability)}
                    </AppText>
                  </View>
                  {available ? (
                    <Chip label={selected ? 'Selected' : 'Use'} active={selected} onPress={() => setEngine(candidate)} />
                  ) : (
                    <AppText variant="caption" faint>
                      Unavailable
                    </AppText>
                  )}
                </View>
              </Card>
            );
          })}
        </View>

        <Field
          label="Instruction (optional)"
          value={instruction}
          onChangeText={(value) => {
            setInstruction(value.slice(0, MAX_INSTRUCTION_CHARS));
            setNarrationInstruction(value.slice(0, MAX_INSTRUCTION_CHARS));
          }}
          placeholder="One sentence: pace, emphasis, who it is for…"
          maxLength={MAX_INSTRUCTION_CHARS}
          hint={`${instruction.length}/${MAX_INSTRUCTION_CHARS} · Applies to the script, not the voice.`}
        />
        <AppText variant="caption" faint>
          {selectedStyle.label}s usually land around {LENGTH_PRESETS.find((preset) => preset.id === length)?.words.toLocaleString()} words.
        </AppText>

        {!availableEngines.includes(engine) ? (
          <AppText variant="caption" color={palette.danger}>
            {reasonCopy(probes[engine])} Choose another engine to continue.
          </AppText>
        ) : null}

        <Button
          label="Create narration"
          icon="mic-outline"
          full
          disabled={!probes[engine]?.available}
          onPress={() => void createNarration()}
        />
        {error ? (
          <AppText variant="caption" color={palette.danger}>
            {error}
          </AppText>
        ) : null}
        <AppText variant="caption" faint>
          Creating a narration writes the script and its segments. Nothing is synthesised until you ask for audio.
        </AppText>
      </Screen>
    );
  }

  const engineAvailability = probes[rendition.engine];
  const currentSegment = segments[index];
  const isDevice = mode === 'device';
  const readyCount = segments.filter((segment) => canPlay(segment)).length;
  const allReady = segments.length > 0 && readyCount === segments.length;
  const segmentStartMs = starts[index] ?? 0;
  const segmentDurationMs =
    currentSegment?.durationMs && currentSegment.durationMs > 0
      ? currentSegment.durationMs
      : estimatedDurationMs(currentSegment?.text ?? '');
  const absolutePosition = isDevice
    ? segmentStartMs + deviceElapsedMs
    : segmentStartMs + (status.currentTime ?? 0) * 1000;
  const segmentElapsedMs = Math.max(
    0,
    Math.min(segmentDurationMs, absolutePosition - segmentStartMs),
  );
  const wordProgress = segmentDurationMs > 0 ? segmentElapsedMs / segmentDurationMs : 0;
  const timingTokens = parseSpeechTimings(currentSegment?.timingsJson);
  const timingActiveIndex = timingTokens.length
    ? timingIndexForElapsed(timingTokens, Math.max(0, absolutePosition - segmentStartMs))
    : -1;
  const activeWordIndex = timingTokens.length
    ? -1
    : wordIndexForProgress(currentSegment?.text ?? '', wordProgress);
  const transcriptTokens = tokenizeTranscript(currentSegment?.text ?? '');
  const activeWordStyle = {
    color: palette.accent,
    backgroundColor: palette.accentSoft,
    fontWeight: '700',
  } as const;
  let wordCursor = 0;
  const transcriptSpans = timingTokens.length
    ? timingTokens.map((timing, timingIndex) => (
        <React.Fragment key={`tm${timingIndex}`}>
          <Text style={timingIndex === timingActiveIndex ? activeWordStyle : undefined}>
            {timing.text}
          </Text>
          {timingIndex < timingTokens.length - 1 ? <Text> </Text> : null}
        </React.Fragment>
      ))
    : transcriptTokens.map((token, tokenIndex) => {
        if (!token.word) return <Text key={`t${tokenIndex}`}>{token.text}</Text>;
        const wordIndex = wordCursor;
        wordCursor += 1;
        const active = wordIndex === activeWordIndex;
        return (
          <Text
            key={`t${tokenIndex}`}
            style={active ? activeWordStyle : undefined}
          >
            {token.text}
          </Text>
        );
      });
  const overall = totalMs > 0 ? Math.min(1, absolutePosition / totalMs) : 0;
  const currentSectionTitle = sectionTitleForSegment(segments, index);
  const currentTitle =
    currentSectionTitle && currentSectionTitle.toLowerCase() !== book.title.trim().toLowerCase()
      ? currentSectionTitle
      : 'Section';
  const activeVoiceName =
    voices.find((voice) => voice.identifier === narrationVoice)?.name ??
    NARRATION_LANGUAGES.find((option) => option.id === language)?.label ??
    language;

  return (
    <Screen scroll={false}>
      <Header
        title="Listen"
        onBack={() => router.back()}
        right={<IconButton name="moon-outline" label="Sleep timer" onPress={() => setSleepOpen(true)} />}
      />

      <View style={{ flex: 1, justifyContent: 'flex-start', gap: space.md, paddingTop: space.sm }}>
        <View style={{ alignItems: 'center', gap: space.sm }}>
          {book.coverUrl ? (
            <Cover
              uri={book.coverUrl}
              title={book.title}
              width={88}
              height={120}
              style={{ borderRadius: radius.md }}
            />
          ) : (
            <View
              style={{
                width: 88,
                height: 88,
                borderRadius: radius.md,
                backgroundColor: palette.surface,
                borderWidth: 1,
                borderColor: palette.line,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <BrandMark size={52} />
            </View>
          )}
          <AppText variant="title" serif style={{ textAlign: 'center' }}>
            {book.title}
          </AppText>
          <AppText variant="caption" faint style={{ textAlign: 'center' }}>
            {currentTitle} · {ENGINE_LABEL[rendition.engine]} · {getNarrationStyle(rendition.styleId).label} ·{' '}
            {rendition.length} min
            {segments.length ? ` · segment ${index + 1} of ${segments.length}` : ''}
          </AppText>
        </View>

        <View style={{ alignItems: 'center' }}>
          <Button
            label="Guide"
            icon="sparkles-outline"
            variant="secondary"
            size="sm"
            onPress={() =>
              router.push({ pathname: '/guide/[id]', params: { id: rendition.id } })
            }
          />
        </View>

        {rendition.status === 'draft' ? (
          <Card>
            <AppText variant="bodySm" style={{ fontWeight: '600' }}>
              No script yet
            </AppText>
            <AppText variant="caption" faint style={{ marginTop: 4 }}>
              Write the {getNarrationStyle(rendition.styleId).label.toLowerCase()} script for this narration. Audio
              comes next, when you ask for it.
            </AppText>
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
              <Button label="Write script" icon="create-outline" size="sm" onPress={() => openGeneration(rendition)} />
              <Button label="Change engine" variant="secondary" size="sm" onPress={() => setEngineSheet(true)} />
            </View>
          </Card>
        ) : null}

        {rendition.status === 'scripting' ? (
          <Card>
            <AppText variant="bodySm">Writing the script…</AppText>
            <AppText variant="caption" faint style={{ marginTop: 4 }}>
              Progress, the estimate and cancel live on the Generating screen.
            </AppText>
            <View style={{ marginTop: space.md }}>
              <Button label="View progress" variant="secondary" size="sm" onPress={() => openGeneration(rendition)} />
            </View>
          </Card>
        ) : null}

        {rendition.status === 'script_ready' ? (
          <Card>
            <AppText variant="bodySm" style={{ fontWeight: '600' }}>
              Ready to generate audio
            </AppText>
            <AppText variant="caption" faint style={{ marginTop: 4 }}>
              {rendition.wordCount.toLocaleString()} words · {ENGINE_LABEL[rendition.engine]}
              {rendition.model ? ` · ${rendition.model}` : ''}
            </AppText>
            <AppText variant="caption" faint style={{ marginTop: 4 }}>
              {segments.length
                ? `${segments.length} segment${segments.length === 1 ? '' : 's'} planned. Nothing is synthesised until you press generate.`
                : 'No segments were planned. The script may be empty; write it again.'}
            </AppText>
            {engineAvailability && !engineAvailability.available ? (
              <AppText variant="caption" color={palette.danger} style={{ marginTop: space.sm }}>
                {REASON_COPY[engineAvailability.reason]}
              </AppText>
            ) : null}
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
              <Button
                label="Generate audio"
                icon="cloud-download-outline"
                size="sm"
                disabled={!engineAvailability?.available || !segments.length}
                onPress={() => openGeneration(rendition)}
              />
              <Button label="Change engine" variant="secondary" size="sm" onPress={() => setEngineSheet(true)} />
            </View>
          </Card>
        ) : null}

        {rendition.status === 'synthesising' ? (
          <Card>
            <AppText variant="bodySm">Recording audio…</AppText>
            <View style={{ marginTop: space.sm }}>
              <ProgressBar value={segments.length ? readyCount / segments.length : 0} />
            </View>
            <AppText variant="caption" faint style={{ marginTop: 4 }}>
              {readyCount}/{segments.length} segments ready. Finished segments are kept if you cancel.
            </AppText>
            <View style={{ marginTop: space.md }}>
              <Button label="View progress" variant="secondary" size="sm" onPress={() => openGeneration(rendition)} />
            </View>
          </Card>
        ) : null}

        {rendition.status === 'failed' ? (
          <Card style={{ borderColor: palette.dangerSoft }}>
            <AppText variant="bodySm" color={palette.danger} style={{ fontWeight: '600' }}>
              {rendition.scriptMd ? 'Audio did not finish' : 'The script did not finish'}
            </AppText>
            <AppText variant="caption" muted style={{ marginTop: 4 }}>
              {rendition.error === 'cancelled'
                ? 'Cancelled. Finished work is kept, so retry resumes from the next step.'
                : rendition.error ?? (rendition.scriptMd ? 'The last run stopped before every segment was ready.' : 'No script was written.')}
            </AppText>
            {engineAvailability && !engineAvailability.available ? (
              <AppText variant="caption" color={palette.danger} style={{ marginTop: 4 }}>
                {REASON_COPY[engineAvailability.reason]}
              </AppText>
            ) : null}
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
              <Button
                label={rendition.scriptMd ? 'Retry' : 'Write script'}
                icon={rendition.scriptMd ? 'refresh-outline' : 'create-outline'}
                size="sm"
                disabled={!engineAvailability?.available && !rendition.scriptMd}
                onPress={() => openGeneration(rendition)}
              />
              <Button label="Change engine" variant="secondary" size="sm" onPress={() => setEngineSheet(true)} />
              <Button
                label="Re-make"
                variant="ghost"
                size="sm"
                onPress={() => router.push({ pathname: '/book/[id]', params: { id: book.id } })}
              />
            </View>
          </Card>
        ) : null}

        {rendition.status === 'ready' ? (
          <>
            <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
              <ScrollView style={{ maxHeight: 180 }} showsVerticalScrollIndicator={false}>
                {transcriptTokens.length || timingTokens.length ? (
                  <AppText variant="bodySm" serif muted>
                    {transcriptSpans}
                  </AppText>
                ) : (
                  <AppText variant="bodySm" serif muted>
                    This narration has no segments.
                  </AppText>
                )}
              </ScrollView>
            </Card>

            <View style={{ gap: space.sm }}>
              <ProgressBar value={overall} height={8} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <AppText variant="caption" faint>
                  {formatDuration(absolutePosition)} / {formatDuration(totalMs)}
                </AppText>
                {sleepLabel ? (
                  <AppText variant="caption" color={palette.warm}>
                    Sleep in {sleepLabel}
                  </AppText>
                ) : (
                  <AppText variant="caption" faint>
                    {Math.round(overall * 100)}% narrated
                  </AppText>
                )}
              </View>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.lg }}>
              <IconButton
                name="play-skip-back"
                label="Back fifteen seconds"
                onPress={() => seek(-15_000)}
              />
              <Button
                label={playing ? 'Pause' : 'Play'}
                icon={playing ? 'pause' : 'play'}
                onPress={() => void toggle()}
                size="lg"
              />
              <IconButton name="play-skip-forward" label="Forward fifteen seconds" onPress={() => seek(15_000)} />
            </View>

            {!isDevice && !allReady ? (
              <Card style={{ borderColor: palette.line }}>
                <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                  Download audio to continue
                </AppText>
                <AppText variant="caption" faint style={{ marginTop: 4 }}>
                  {readyCount}/{segments.length} segments are ready. Generate the remaining audio to play past this
                  point.
                </AppText>
                <View style={{ marginTop: space.md }}>
                  <Button
                    label="Generate remaining audio"
                    icon="cloud-download-outline"
                    size="sm"
                    disabled={!engineAvailability?.available}
                    onPress={() => openGeneration(rendition)}
                  />
                </View>
              </Card>
            ) : null}

            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.sm, flexWrap: 'wrap' }}>
              {RATES.map((rate) => (
                <Chip
                  key={rate}
                  label={`${rate}×`}
                  active={narrationRate === rate}
                  onPress={() => {
                    if (!isDevice) return;
                    setNarrationRate(rate);
                    if (playing) {
                      stopping.current = true;
                      speechSeq.current += 1;
                      void Speech.stop();
                      setPlaying(false);
                      setTimeout(() => speakSegment(index), 120);
                    }
                  }}
                />
              ))}
            </View>
            {!isDevice ? (
              <AppText variant="caption" faint style={{ textAlign: 'center' }}>
                Speed is set when the audio is generated. File playback stays at 1×.
              </AppText>
            ) : null}

            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.sm, flexWrap: 'wrap' }}>
              {markers.length > 1 ? (
                <Button label="Chapters" icon="list-outline" variant="secondary" size="sm" onPress={() => setChaptersOpen(true)} />
              ) : null}
              {isDevice ? (
                <Button
                  label={`Voice · ${activeVoiceName}`}
                  icon="mic-outline"
                  variant="secondary"
                  size="sm"
                  onPress={() => setVoiceOpen(true)}
                />
              ) : null}
              <Button
                label="Re-make"
                icon="shuffle-outline"
                variant="ghost"
                size="sm"
                onPress={() => router.push({ pathname: '/book/[id]', params: { id: book.id } })}
              />
            </View>

            {notice ? (
              <AppText variant="caption" color={palette.warm} style={{ textAlign: 'center' }}>
                {notice}
              </AppText>
            ) : null}
          </>
        ) : null}

        {error ? (
          <AppText variant="caption" color={palette.danger} style={{ textAlign: 'center' }}>
            {error}
          </AppText>
        ) : null}

        <AppText variant="caption" faint style={{ textAlign: 'center' }}>
          {isDevice
            ? 'Narrated by your device’s speech engine. No audio leaves your phone.'
            : 'Audio is generated once and stored on this device. Playback uses the lock-screen controls.'}
        </AppText>
      </View>

      <Sheet visible={engineSheet} onClose={() => setEngineSheet(false)} title="Change voice engine">
        <AppText variant="caption" faint>
          Switching engine re-plans the segments with new cache keys. Existing audio is not reused.
        </AppText>
        {(['device', 'remote', 'piper', 'kokoro'] as const).map((candidate) => {
          const availability = probes[candidate];
          const available = availability?.available ?? false;
          const selected = rendition.engine === candidate;
          return (
            <Card key={candidate} style={{ paddingVertical: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                    {ENGINE_LABEL[candidate]}
                  </AppText>
                  <AppText variant="caption" faint>
                    {available ? (selected ? 'Current engine' : 'Available') : reasonCopy(availability)}
                  </AppText>
                </View>
                {available ? (
                  <Button
                    label={selected ? 'Selected' : 'Use'}
                    size="sm"
                    variant={selected ? 'secondary' : 'primary'}
                    disabled={selected}
                    onPress={() => void changeEngine(candidate)}
                  />
                ) : (
                  <AppText variant="caption" faint>
                    Unavailable
                  </AppText>
                )}
              </View>
            </Card>
          );
        })}
      </Sheet>

      <Sheet visible={chaptersOpen} onClose={() => setChaptersOpen(false)} title="Chapters">
        {markers.map((marker) => {
          const segmentIndex = segments.findIndex((segment, i) => (starts[i] ?? 0) === marker.startMs);
          return (
            <Button
              key={`${marker.startMs}:${marker.title}`}
              label={`${formatDuration(marker.startMs)} · ${marker.title}`}
              variant="ghost"
              full
              onPress={() => jumpToSegment(segmentIndex)}
            />
          );
        })}
      </Sheet>

      <Sheet visible={voiceOpen} onClose={() => setVoiceOpen(false)} title="Narration voice">
        <AppText variant="label" muted>
          Language
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {NARRATION_LANGUAGES.map((option) => (
            <Chip
              key={option.id}
              label={option.label}
              active={language === option.id}
              onPress={() => changeLanguage(option.id)}
            />
          ))}
        </View>
        <Divider />
        <AppText variant="label" muted>
          Device voices ({voicesForLanguage(voices, language).length})
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {voicesForLanguage(voices, language)
            .slice(0, 12)
            .map((voice) => (
              <Chip
                key={voice.identifier}
                label={voice.name}
                active={narrationVoice === voice.identifier}
                onPress={() => setNarrationVoice(voice.identifier)}
              />
            ))}
          {voicesForLanguage(voices, language).length === 0 ? (
            <AppText variant="caption" faint>
              This device reports no voices for that language; the system default will be used.
            </AppText>
          ) : null}
        </View>
      </Sheet>

      <Sheet visible={sleepOpen} onClose={() => setSleepOpen(false)} title="Sleep timer">
        {[15, 30, 45, 60].map((minutes) => (
          <Button
            key={minutes}
            label={`${minutes} minutes`}
            variant="secondary"
            full
            onPress={() => {
              setSleepUntil(Date.now() + minutes * 60_000);
              setSleepLabel(`${minutes} min`);
              setSleepOpen(false);
            }}
          />
        ))}
        <Button
          label="Turn off"
          variant="ghost"
          full
          onPress={() => {
            setSleepUntil(null);
            setSleepLabel(null);
            setSleepOpen(false);
          }}
        />
      </Sheet>
    </Screen>
  );
}

function findRendition(renditions: Rendition[], id: string): Rendition | null {
  return renditions.find((rendition) => rendition.id === id) ?? null;
}
