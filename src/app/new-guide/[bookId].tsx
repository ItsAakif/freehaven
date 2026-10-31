import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  Screen,
  AppText,
  Card,
  Button,
  Chip,
  Field,
  Header,
  SectionHeader,
  Sheet,
  EmptyState,
  LoadingBlock,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { getBook } from '@/data/repositories/books';
import { getDocument, listSections } from '@/data/repositories/reading';
import {
  getOrCreateGuide,
  listGuides,
  replaceGuideChapters,
  setGuideEngine,
} from '@/data/repositories/guides';
import type { Book, Document, Section } from '@/domain/types';
import type { Guide } from '@/domain/guides';
import type { RenditionEngine } from '@/domain/narration';
import { wordCount } from '@/domain/text';
import {
  detectChapters,
  mergeDetected,
  splitDetected,
  type DetectedChapter,
  type SectionRef,
} from '@/features/guides/detect';
import { GUIDE_WORDS_PER_CHAPTER } from '@/features/guides/constants';
import { estimateGuideBuild, estimateGuideCopy, type GuideEstimate } from '@/features/guides/estimate';
import { startGuideGeneration } from '@/features/guides/generate';
import {
  extractPdfOutlineNative,
  extractPdfPagesNative,
} from '@/features/imports/pdfNative';
import {
  probeNarrationEngines,
  type EngineUnavailableReason,
} from '@/features/narration/engines';
import { DEFAULT_STYLE_ID, getNarrationStyle } from '@/features/narration/styles';

const ENGINE_ORDER: RenditionEngine[] = ['device', 'remote', 'piper', 'kokoro'];

const ENGINE_LABELS: Record<RenditionEngine, string> = {
  device: 'Device',
  remote: 'Remote',
  piper: 'Piper',
  kokoro: 'Kokoro',
};

const ENGINE_REASON_COPY: Record<EngineUnavailableReason, string> = {
  not_installed: 'not installed in this build',
  no_model: 'no voice model installed',
  load_failed: 'voice engine failed to load',
  model_absent: 'no voice model downloaded',
  model_unverified: 'model needs verification',
  needs_extraction: 'model needs extracting',
  no_key: 'add a provider key',
  no_base_url: 'set a provider base URL',
  unsupported_platform: 'not supported on this device',
};

type ProbeSet = Awaited<ReturnType<typeof probeNarrationEngines>>;

type Loaded =
  | {
      kind: 'ready';
      book: Book;
      document: Document | null;
      sections: Section[];
      refs: SectionRef[];
      existing: Guide | null;
      detected: DetectedChapter[];
      equalWarning: boolean;
      probes: ProbeSet;
    }
  | null;

function engineDuration(estimate: GuideEstimate, engine: RenditionEngine): string {
  if (engine === 'device' || estimate.synthHighMs < 10_000) return 'instant';
  const highMinutes = Math.max(1, Math.round(estimate.synthHighMs / 60_000));
  if (highMinutes >= 60) {
    const lowHours = Math.max(1, Math.round(estimate.synthLowMs / 3_600_000));
    const highHours = Math.max(1, Math.round(estimate.synthHighMs / 3_600_000));
    return `~${lowHours}–${highHours} hr`;
  }
  const lowMinutes = Math.max(1, Math.round(estimate.synthLowMs / 60_000));
  return `~${lowMinutes}–${highMinutes} min`;
}

export default function NewGuideScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const { palette } = useTheme();

  const [chapters, setChapters] = useState<DetectedChapter[] | null>(null);
  const [engine, setEngine] = useState<RenditionEngine>('device');
  const [splitIndex, setSplitIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const originalRef = useRef<DetectedChapter[] | null>(null);
  const seededRef = useRef<string | null>(null);

  const state = useAsync<Loaded>(async () => {
    const book = await getBook(bookId);
    if (!book) return null;

    const language = book.language ?? 'en';
    const [document, guides, probes] = await Promise.all([
      getDocument(book.id),
      listGuides(book.id),
      probeNarrationEngines(),
    ]);
    const sections = document ? await listSections(document.id) : [];
    const refs: SectionRef[] = sections.map((section) => ({
      id: section.id,
      title: section.title ?? null,
      startPage: section.startPage ?? null,
      endPage: section.endPage ?? null,
      wordCount: wordCount(section.text ?? ''),
    }));
    const existing =
      guides.find(
        (guide) => guide.language === language && guide.styleId === DEFAULT_STYLE_ID,
      ) ?? null;

    if (existing && existing.status !== 'draft') {
      return {
        kind: 'ready',
        book,
        document,
        sections,
        refs,
        existing,
        detected: [],
        equalWarning: false,
        probes,
      };
    }

    if (!document || refs.length === 0) {
      return {
        kind: 'ready',
        book,
        document,
        sections,
        refs,
        existing,
        detected: [],
        equalWarning: false,
        probes,
      };
    }

    if (document.format === 'pdf') {
      const [outline, pages] = document.filePath
        ? await Promise.all([
            extractPdfOutlineNative(document.filePath),
            extractPdfPagesNative(document.filePath),
          ])
        : [null, null];
      const detected = detectChapters({
        kind: 'pdf',
        pages: pages ?? [],
        sections: refs,
        outline: outline ?? null,
      });
      return {
        kind: 'ready',
        book,
        document,
        sections,
        refs,
        existing,
        detected,
        equalWarning: !outline && !(pages && pages.length),
        probes,
      };
    }

    const detected = detectChapters({
      kind: document.format === 'epub' ? 'epub' : 'text',
      sections: refs,
    });
    return {
      kind: 'ready',
      book,
      document,
      sections,
      refs,
      existing,
      detected,
      equalWarning: false,
      probes,
    };
  }, [bookId]);

  useEffect(() => {
    const data = state.data;
    if (!data || seededRef.current === data.book.id) return;
    seededRef.current = data.book.id;
    originalRef.current = data.detected;
    setChapters(data.detected);
    setCanUndo(true);
    if (data.probes.kokoro?.available) setEngine('kokoro');
  }, [state.data]);

  if (state.loading) {
    return (
      <Screen>
        <Header title="New full guide" onBack={() => router.back()} />
        <LoadingBlock label="Detecting chapters…" />
      </Screen>
    );
  }

  if (!state.data) {
    return (
      <Screen>
        <Header title="New full guide" onBack={() => router.back()} />
        <EmptyState
          icon="book-outline"
          title="Book not found"
          body="It may have been removed from your library."
        />
      </Screen>
    );
  }

  const data = state.data;

  if (data.existing && data.existing.status !== 'draft') {
    return (
      <Screen>
        <Header title="Full guide" subtitle={data.book.title} onBack={() => router.back()} />
        <EmptyState
          icon="sparkles-outline"
          title="A full guide already exists"
          body="This book already has a chapter-by-chapter guide. Rebuilding is not available in this version."
          actionLabel="Open full guide"
          onAction={() =>
            router.replace({
              pathname: '/full-guide/[guideId]',
              params: { guideId: data.existing!.id },
            })
          }
        />
      </Screen>
    );
  }

  if (chapters === null) {
    return (
      <Screen>
        <Header title="New full guide" subtitle={data.book.title} onBack={() => router.back()} />
        <LoadingBlock label="Preparing chapters…" />
      </Screen>
    );
  }

  const estimate = chapters.length
    ? estimateGuideBuild({
        chapters: chapters.length,
        wordsPerChapter: GUIDE_WORDS_PER_CHAPTER,
        engine,
      })
    : null;
  const copy = estimate ? estimateGuideCopy(estimate, engine) : null;
  const availableEngines = ENGINE_ORDER.filter(
    (candidate) => data.probes[candidate]?.available,
  );
  const comparison = estimate
    ? availableEngines
        .map(
          (candidate) =>
            `${ENGINE_LABELS[candidate]}: ${engineDuration(
              estimateGuideBuild({
                chapters: chapters.length,
                wordsPerChapter: GUIDE_WORDS_PER_CHAPTER,
                engine: candidate,
              }),
              candidate,
            )}`,
        )
        .join(' · ')
    : '';
  const splitChapter = splitIndex !== null ? chapters[splitIndex] ?? null : null;
  const refById = new Map(data.refs.map((ref) => [ref.id, ref]));
  const engineAvailable = !!data.probes[engine]?.available;
  const canCreate =
    !busy &&
    chapters.length > 0 &&
    chapters.every((chapter) => chapter.title.trim().length > 0 && chapter.sectionIds.length > 0) &&
    engineAvailable;

  const updateTitle = (index: number, title: string) => {
    setChapters((current) =>
      current
        ? current.map((chapter, chapterIndex) =>
            chapterIndex === index ? { ...chapter, title } : chapter,
          )
        : current,
    );
  };

  const exclude = (index: number) => {
    setChapters((current) =>
      current
        ? current
            .filter((_, chapterIndex) => chapterIndex !== index)
            .map((chapter, ordinal) => ({ ...chapter, ordinal }))
        : current,
    );
  };

  const create = () => {
    if (!canCreate || !chapters) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const style = getNarrationStyle(DEFAULT_STYLE_ID);
        const voice = style.defaultVoices[engine] ?? 'default';
        const model = engine === 'remote' ? 'tts-1' : engine;
        const guide = await getOrCreateGuide({
          bookId: data.book.id,
          title: data.book.title,
          styleId: DEFAULT_STYLE_ID,
          language: data.book.language ?? 'en',
          engine,
          voice,
          model,
          wordsPerChapter: GUIDE_WORDS_PER_CHAPTER,
        });
        if (guide.status !== 'draft') {
          router.replace({
            pathname: '/full-guide/[guideId]',
            params: { guideId: guide.id },
          });
          return;
        }
        await setGuideEngine(guide.id, { engine, voice, model });
        await replaceGuideChapters(
          guide.id,
          chapters.map((chapter) => ({
            title: chapter.title.trim(),
            startPage: chapter.startPage,
            endPage: chapter.endPage,
            sectionIds: chapter.sectionIds,
          })),
        );
        void startGuideGeneration({ guideId: guide.id, mode: 'all' });
        router.replace({
          pathname: '/full-guide/[guideId]',
          params: { guideId: guide.id },
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Screen>
      <Header title="New full guide" subtitle={data.book.title} onBack={() => router.back()} />

      <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
        <AppText variant="label" muted>
          STYLE
        </AppText>
        <AppText variant="bodySm" serif style={{ marginTop: 2 }}>
          Fireside · {GUIDE_WORDS_PER_CHAPTER} words per chapter
        </AppText>
        <AppText variant="caption" faint style={{ marginTop: 4 }}>
          {getNarrationStyle(DEFAULT_STYLE_ID).persona}
        </AppText>
      </Card>

      {!data.document ? (
        <Card style={{ borderColor: palette.dangerSoft, backgroundColor: palette.dangerSoft }}>
          <AppText variant="bodySm" color={palette.danger}>
            Import or download a readable copy first. A full guide is written from the text already
            on this device.
          </AppText>
        </Card>
      ) : null}

      {data.equalWarning ? (
        <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.line }}>
          <AppText variant="bodySm" muted>
            No PDF outline or page text was found. These are equal page groups; rename, merge or
            split before generating.
          </AppText>
        </Card>
      ) : null}

      <View style={{ gap: space.sm }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: space.md,
          }}
        >
          <SectionHeader title="Chapters" />
          <Button
            label="Undo"
            size="sm"
            variant="ghost"
            disabled={!canUndo}
            onPress={() => setChapters(originalRef.current)}
          />
        </View>
        <AppText variant="caption" faint>
          {chapters.length} detected. Merge adjacent chapters, split at a section boundary, or
          exclude pages that are not part of the book.
        </AppText>
      </View>

      {chapters.map((chapter, index) => (
        <Card key={`${index}-${chapter.sectionIds[0] ?? chapter.title}`} style={{ paddingVertical: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
            <View
              style={{
                width: 26,
                height: 26,
                borderRadius: 13,
                backgroundColor: palette.accentSoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
                {index + 1}
              </AppText>
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Field
                value={chapter.title}
                onChangeText={(value) => updateTitle(index, value)}
                placeholder="Chapter title"
              />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
                <AppText variant="caption" faint>
                  {chapter.startPage
                    ? `pp. ${chapter.startPage}–${chapter.endPage ?? chapter.startPage}`
                    : 'Chapter'}
                </AppText>
                <AppText variant="caption" faint>
                  ~{chapter.wordCount.toLocaleString()} words
                </AppText>
                <AppText
                  variant="caption"
                  color={chapter.confidence === 'high' ? palette.accent : palette.warm}
                >
                  {chapter.confidence} confidence
                </AppText>
              </View>
            </View>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
            <Button
              label="Merge with next"
              size="sm"
              variant="secondary"
              disabled={index === chapters.length - 1}
              onPress={() =>
                setChapters((current) => (current ? mergeDetected(current, index) : current))
              }
            />
            <Button
              label="Split"
              size="sm"
              variant="secondary"
              disabled={chapter.sectionIds.length < 2}
              onPress={() => setSplitIndex(index)}
            />
            <Button label="Exclude" size="sm" variant="ghost" onPress={() => exclude(index)} />
          </View>
        </Card>
      ))}

      {chapters.length === 0 ? (
        <EmptyState
          icon="list-outline"
          title="No chapters detected"
          body="This document has no readable sections yet. Import or re-extract the book, then try again."
        />
      ) : null}

      <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
        <AppText variant="label" muted>
          ESTIMATE
        </AppText>
        {copy && estimate ? (
          <>
            <AppText variant="bodySm" serif style={{ marginTop: 2 }}>
              {copy.short}
            </AppText>
            <AppText variant="caption" faint style={{ marginTop: 4 }}>
              {copy.detail}
            </AppText>
            {comparison ? (
              <AppText variant="caption" faint style={{ marginTop: 6 }}>
                {comparison}
              </AppText>
            ) : null}
            <AppText variant="caption" faint style={{ marginTop: 6 }}>
              {estimate.modelCalls} model calls · {estimate.segments} audio segments
            </AppText>
          </>
        ) : (
          <AppText variant="caption" faint style={{ marginTop: 4 }}>
            Add at least one chapter to see the estimate.
          </AppText>
        )}
      </Card>

      <View style={{ gap: space.sm }}>
        <AppText variant="label" muted>
          Voice engine
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {ENGINE_ORDER.map((candidate) => {
            const availability = data.probes[candidate];
            const enabled = !!availability?.available;
            const reason =
              availability && !availability.available
                ? ENGINE_REASON_COPY[availability.reason]
                : null;
            return (
              <Chip
                key={candidate}
                label={enabled ? ENGINE_LABELS[candidate] : `${ENGINE_LABELS[candidate]} · ${reason}`}
                active={engine === candidate}
                onPress={enabled ? () => setEngine(candidate) : undefined}
              />
            );
          })}
        </View>
        <AppText variant="caption" faint>
          Generation starts as soon as you create the guide. Finished chapters are kept if you
          leave the screen.
        </AppText>
      </View>

      {error ? (
        <AppText variant="caption" color={palette.danger}>
          {error}
        </AppText>
      ) : null}

      <Button
        label="Create full guide"
        icon="sparkles-outline"
        onPress={create}
        loading={busy}
        disabled={!canCreate}
        full
      />
      {!engineAvailable ? (
        <AppText variant="caption" color={palette.danger}>
          Choose an available voice engine to continue.
        </AppText>
      ) : null}

      <Sheet
        visible={!!splitChapter}
        onClose={() => setSplitIndex(null)}
        title="Split chapter"
      >
        <AppText variant="caption" faint>
          The second half starts at the section you pick.
        </AppText>
        {(splitChapter?.sectionIds ?? []).slice(1).map((sectionId) => {
          const ref = refById.get(sectionId);
          return (
            <Pressable
              key={sectionId}
              onPress={() => {
                if (splitIndex === null || !chapters) return;
                setChapters(splitDetected(chapters, splitIndex, sectionId, data.refs));
                setSplitIndex(null);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Split at ${ref?.title ?? sectionId}`}
              style={{
                paddingVertical: space.md,
                borderBottomWidth: 1,
                borderBottomColor: palette.line,
              }}
            >
              <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                {ref?.startPage ? `Page ${ref.startPage}` : 'Section'}
                {ref?.title ? ` · ${ref.title}` : ''}
              </AppText>
            </Pressable>
          );
        })}
      </Sheet>
    </Screen>
  );
}
