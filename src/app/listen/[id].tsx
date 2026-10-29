import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Speech from 'expo-speech';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  AppText,
  Card,
  Button,
  Chip,
  Header,
  IconButton,
  ProgressBar,
  Sheet,
  EmptyState,
  LoadingBlock,
  Divider,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { getBook } from '@/data/repositories/books';
import { getDocument, getReadingPosition, listSections, saveReadingPosition } from '@/data/repositories/reading';
import { syncQueue, markQueueItem, type QueueItem } from '@/data/repositories/audioQueue';
import { usePreferences } from '@/state/preferences';
import { encodeLocator, decodeLocator } from '@/features/reader/readerHtml';
import { NARRATION_LANGUAGES, resolveSpeechProvider, voicesForLanguage, type DeviceVoice } from '@/features/audio';
import { downloadSections } from '@/features/audio/download';

const RATES = [0.75, 1, 1.25, 1.5];

function splitForSpeech(text: string, max = 480): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|\S+$/g) ?? [text];
  const out: string[] = [];
  let buffer = '';
  for (const sentence of sentences) {
    if ((buffer + sentence).length > max && buffer) {
      out.push(buffer.trim());
      buffer = '';
    }
    buffer += sentence;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

export default function ListenScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const narrationRate = usePreferences((s) => s.narrationRate);
  const setNarrationRate = usePreferences((s) => s.setNarrationRate);
  const narrationVoice = usePreferences((s) => s.narrationVoice);
  const setNarrationVoice = usePreferences((s) => s.setNarrationVoice);
  const language = usePreferences((s) => s.narrationLanguage);
  const setLanguage = usePreferences((s) => s.setNarrationLanguage);
  const studioEnabled = usePreferences((s) => s.studioVoice);
  const setStudioEnabled = usePreferences((s) => s.setStudioVoice);
  const keyPresent = usePreferences((s) => s.aiKeyPresent);
  const speechModel = usePreferences((s) => s.speechModel);
  const speechVoice = usePreferences((s) => s.speechVoice);

  const [playing, setPlaying] = useState(false);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [partIndex, setPartIndex] = useState(0);
  const [sleepOpen, setSleepOpen] = useState(false);
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepLabel, setSleepLabel] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voices, setVoices] = useState<DeviceVoice[]>([]);
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadLabel, setDownloadLabel] = useState<string | null>(null);
  const stopping = useRef(false);

  const studio = studioEnabled && keyPresent;
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const startNextRef = useRef<(index: number) => void>(() => {});

  const state = useAsync(async () => {
    const book = await getBook(id);
    if (!book) return { book: null } as const;
    const document = await getDocument(book.id);
    if (!document) return { book, sections: [], position: null } as const;
    const [sections, position] = await Promise.all([listSections(document.id), getReadingPosition(book.id)]);
    const readable = sections.filter((s) => (s.text ?? '').trim().length > 0);
    const queue = await syncQueue(book.id, readable.map((s) => ({ id: s.id, title: s.title })));
    return { book, sections: readable, position, queue } as const;
  }, [id]);

  useEffect(() => {
    void Speech.getAvailableVoicesAsync()
      .then((available) =>
        setVoices(
          available.map((v) => ({
            identifier: v.identifier,
            name: v.name,
            language: v.language,
            quality: v.quality,
          })),
        ),
      )
      .catch(() => setVoices([]));
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const section = state.data?.sections?.[sectionIndex];
    if (!section) return;
    const loc = decodeLocator(state.data?.position?.locator ?? null);
    if (loc?.sectionId === section.id && loc.para) setPartIndex(loc.para);
  }, [state.data?.position, state.data?.sections, sectionIndex]);

  useEffect(() => {
    player.setPlaybackRate(narrationRate);
  }, [narrationRate, player]);

  useEffect(() => {
    return () => {
      stopping.current = true;
      void Speech.stop();
    };
  }, []);

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

  const sections = useMemo(() => state.data?.sections ?? [], [state.data?.sections]);
  const section = sections[sectionIndex];
  const parts = useMemo(() => splitForSpeech(section?.text ?? ''), [section?.text]);
  const part = parts[partIndex] ?? '';
  const queue: QueueItem[] = state.data?.queue ?? [];

  const persist = useCallback(
    (nextSection: number, nextPart: number) => {
      if (!state.data?.book || !sections.length) return;
      const percent = Math.min(1, (nextSection + nextPart / Math.max(1, parts.length)) / sections.length);
      void saveReadingPosition({
        bookId: state.data.book.id,
        locator: encodeLocator({ sectionId: sections[nextSection].id, para: nextPart, start: 0, end: 0 }),
        percent,
        sectionTitle: sections[nextSection].title ?? null,
        updatedAt: Date.now(),
      });
    },
    [parts.length, sections, state.data?.book],
  );

  function speakFrom(nextSection: number, nextPart: number) {
    if (!sections.length) return;
    const targetParts = nextSection === sectionIndex ? parts : splitForSpeech(sections[nextSection].text ?? '');
    const text = targetParts[nextPart];
    if (!text) {
      if (nextSection < sections.length - 1) {
        setSectionIndex(nextSection + 1);
        setPartIndex(0);
        speakFrom(nextSection + 1, 0);
      } else {
        setPlaying(false);
      }
      return;
    }
    stopping.current = false;
    setPlaying(true);
    Speech.speak(text, {
      rate: narrationRate,
      language,
      voice: narrationVoice ?? undefined,
      onDone: () => {
        if (stopping.current) return;
        const isLastPart = nextPart >= targetParts.length - 1;
        if (isLastPart) {
          persist(nextSection, nextPart);
          const next = nextSection + 1;
          if (next < sections.length) {
            setSectionIndex(next);
            setPartIndex(0);
            speakFrom(next, 0);
          } else {
            setPlaying(false);
          }
        } else {
          setPartIndex(nextPart + 1);
          speakFrom(nextSection, nextPart + 1);
        }
      },
      onError: () => setPlaying(false),
    });
  }

  const startStudio = useCallback(
    async (targetIndex: number) => {
      const target = sections[targetIndex];
      if (!target) return;
      setStudioBusy(true);
      setStudioError(null);
      try {
        const provider = await resolveSpeechProvider();
        if (!provider) throw new Error('Add a remote key in Settings to use studio narration.');
        const text = (target.text ?? '').slice(0, 4000);
        if (!text.trim()) throw new Error('This section has no text to narrate.');
        const asset = await provider.synthesize({
          text,
          language,
          voice: speechVoice,
          model: speechModel,
        });
        player.replace({ uri: asset.uri });
        player.setActiveForLockScreen(true, {
          title: target.title ?? `Section ${targetIndex + 1}`,
          artist: 'Freehaven',
          albumTitle: state.data?.book?.title ?? 'Freehaven',
        });
        player.setPlaybackRate(narrationRate);
        player.play();
        setPlaying(true);
        setSectionIndex(targetIndex);
        setPartIndex(0);
        persist(targetIndex, 0);
      } catch (e) {
        setStudioError((e as Error).message);
        setPlaying(false);
      } finally {
        setStudioBusy(false);
      }
    },
    [language, narrationRate, persist, player, sections, speechModel, speechVoice, state.data?.book?.title],
  );

  startNextRef.current = (index: number) => {
    if (studio) void startStudio(index);
    else speakFrom(index, 0);
  };

  useEffect(() => {
    if (!studio || !status.didJustFinish) return;
    const next = sectionIndex + 1;
    if (next < sections.length) {
      void startStudio(next);
    } else {
      setPlaying(false);
      player.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.didJustFinish]);

  const toggle = async () => {
    if (studio) {
      if (status.playing) {
        player.pause();
        setPlaying(false);
      } else {
        await startStudio(sectionIndex);
      }
      return;
    }
    if (playing) {
      stopping.current = true;
      await Speech.stop();
      setPlaying(false);
      persist(sectionIndex, partIndex);
    } else {
      speakFrom(sectionIndex, partIndex);
    }
  };

  const jump = (nextSection: number) => {
    const clamped = Math.max(0, Math.min(sections.length - 1, nextSection));
    stopping.current = true;
    void Speech.stop();
    player.pause();
    setPlaying(false);
    setSectionIndex(clamped);
    setPartIndex(0);
    persist(clamped, 0);
    const queued = queue[clamped];
    if (queued) void markQueueItem(queued.id, { status: 'done' }).catch(() => {});
  };

  const changeLanguage = async (next: string) => {
    setLanguage(next);
    const available = voicesForLanguage(voices, next);
    const current = available.find((v) => v.identifier === narrationVoice);
    if (!current) setNarrationVoice(available[0]?.identifier ?? null);
  };

  if (state.loading) {
    return (
      <Screen>
        <Header title="Listen" onBack={() => router.back()} />
        <LoadingBlock label="Preparing narration…" />
      </Screen>
    );
  }

  if (!sections.length) {
    return (
      <Screen>
        <Header title="Listen" onBack={() => router.back()} />
        <EmptyState
          icon="headset-outline"
          title="No narration yet"
          body="Narration needs extracted text. Import a book or download a public-domain edition first."
        />
      </Screen>
    );
  }

  const studioProgress =
    studio && status.duration > 0 ? Math.min(1, status.currentTime / status.duration) : 0;
  const overall = studio
    ? Math.round(((sectionIndex + studioProgress) / Math.max(1, sections.length)) * 100)
    : Math.round(((sectionIndex + partIndex / Math.max(1, parts.length)) / sections.length) * 100);
  const activeVoiceName =
    voices.find((v) => v.identifier === narrationVoice)?.name ??
    NARRATION_LANGUAGES.find((l) => l.id === language)?.label ??
    language;

  return (
    <Screen scroll={false}>
      <Header
        title="Listen"
        subtitle={state.data?.book?.title}
        onBack={() => router.back()}
        right={<IconButton name="moon-outline" label="Sleep timer" onPress={() => setSleepOpen(true)} />}
      />

      <View style={{ flex: 1, justifyContent: 'center', gap: space.lg }}>
        <View style={{ alignItems: 'center', gap: space.md }}>
          <View
            style={{
              width: 132,
              height: 132,
              borderRadius: 66,
              backgroundColor: palette.accentSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name={playing ? 'volume-high' : 'headset'} size={48} color={palette.accent} />
          </View>
          <AppText variant="title" serif style={{ textAlign: 'center' }}>
            {section?.title ?? `Section ${sectionIndex + 1}`}
          </AppText>
          <AppText variant="caption" faint>
            Section {sectionIndex + 1} of {sections.length}
            {studio ? ' · studio narration' : ` · part ${partIndex + 1} of ${parts.length}`}
          </AppText>
        </View>

        <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
          <ScrollView style={{ maxHeight: 140 }} showsVerticalScrollIndicator={false}>
            <AppText variant="bodySm" serif muted>
              {studio ? (section?.text ?? '').slice(0, 600) : part}
            </AppText>
          </ScrollView>
        </Card>

        <View style={{ gap: space.sm }}>
          <ProgressBar value={overall / 100} height={8} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <AppText variant="caption" faint>
              {overall}% narrated
            </AppText>
            {sleepLabel ? (
              <AppText variant="caption" color={palette.warm}>
                Sleep in {sleepLabel}
              </AppText>
            ) : null}
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.lg }}>
          <IconButton name="play-skip-back" label="Previous section" onPress={() => jump(sectionIndex - 1)} />
          <Button
            label={playing ? 'Pause' : 'Play'}
            icon={playing ? 'pause' : 'play'}
            onPress={() => void toggle()}
            loading={studioBusy}
            size="lg"
          />
          <IconButton name="play-skip-forward" label="Next section" onPress={() => jump(sectionIndex + 1)} />
        </View>

        {studio ? (
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.sm }}>
            <Button
              label="−15s"
              variant="ghost"
              size="sm"
              onPress={() => void player.seekTo(Math.max(0, status.currentTime - 15))}
            />
            <Button
              label="+15s"
              variant="ghost"
              size="sm"
              onPress={() => void player.seekTo(status.currentTime + 15)}
            />
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.sm }}>
          {RATES.map((rate) => (
            <Chip
              key={rate}
              label={`${rate}×`}
              active={narrationRate === rate}
              onPress={() => {
                setNarrationRate(rate);
                if (studio) {
                  player.setPlaybackRate(rate);
                } else if (playing) {
                  stopping.current = true;
                  void Speech.stop();
                  setPlaying(false);
                  setTimeout(() => speakFrom(sectionIndex, partIndex), 120);
                }
              }}
            />
          ))}
        </View>

        <Button
          label={`Voice · ${studio ? `${speechVoice} (studio)` : activeVoiceName}`}
          icon="mic-outline"
          variant="secondary"
          size="sm"
          onPress={() => setVoiceOpen(true)}
        />

        {studio ? (
          <Button
            label={
              downloadBusy
                ? `Caching… ${downloadLabel ?? ''}`
                : `Download audio · ${queue.filter((q) => q.status === 'ready').length}/${queue.length}`
            }
            icon="cloud-download-outline"
            variant="secondary"
            size="sm"
            loading={downloadBusy}
            onPress={() =>
              void (async () => {
                const provider = await resolveSpeechProvider();
                if (!provider) {
                  setStudioError('Add a remote key in Settings to cache studio audio.');
                  return;
                }
                setDownloadBusy(true);
                setStudioError(null);
                try {
                  await downloadSections({
                    queue,
                    sections: sections.map((s) => ({ id: s.id, title: s.title, text: s.text })),
                    provider,
                    voice: speechVoice,
                    model: speechModel,
                    language,
                    onProgress: (p) => setDownloadLabel(`${p.done}/${p.total}`),
                  });
                  state.reload();
                } catch (e) {
                  setStudioError((e as Error).message);
                } finally {
                  setDownloadBusy(false);
                }
              })()
            }
          />
        ) : null}

        {studioError ? (
          <AppText variant="caption" color={palette.danger} style={{ textAlign: 'center' }}>
            {studioError}
          </AppText>
        ) : null}

        <AppText variant="caption" faint style={{ textAlign: 'center' }}>
          {studio
            ? 'Studio narration is synthesised once, cached on device, and played with lock-screen controls.'
            : 'Narrated by your device’s speech engine. No audio leaves your phone.'}
        </AppText>
      </View>

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
              onPress={() => void changeLanguage(option.id)}
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
        <Divider />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <AppText variant="bodySm" style={{ fontWeight: '600' }}>
              Studio narration
            </AppText>
            <AppText variant="caption" faint>
              {keyPresent
                ? `Synthesise with ${speechModel} · ${speechVoice}, cache the MP3, and use lock-screen controls.`
                : 'Add a remote key in Settings to enable file-based narration.'}
            </AppText>
          </View>
          <Button
            label={studioEnabled ? 'On' : 'Off'}
            size="sm"
            variant={studioEnabled ? 'primary' : 'secondary'}
            disabled={!keyPresent}
            onPress={() => setStudioEnabled(!studioEnabled)}
          />
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
