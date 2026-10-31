import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { BrandLockup } from '@/design/brand';
import {
  Screen,
  AppText,
  Card,
  Button,
  Header,
  ProgressBar,
  Divider,
  EmptyState,
  LoadingBlock,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { getBook } from '@/data/repositories/books';
import {
  completeGuideChapter,
  getGuide,
  guideStats,
  listGuideChapters,
  uncompleteGuideChapter,
} from '@/data/repositories/guides';
import type { GuideChapter } from '@/domain/guides';
import {
  cancelGuideGeneration,
  isGuideRunning,
  startGuideGeneration,
} from '@/features/guides/generate';
import { stripChapterNumber } from '@/features/guides/detect';
import { writeFullGuidePdf } from '@/features/export/fullGuidePdf';

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '0:00';
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function summaryExcerpt(markdown: string | null): string {
  if (!markdown) return '';
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 180).trimEnd()}…` : text;
}

function chapterStatusLine(chapter: GuideChapter): string {
  switch (chapter.status) {
    case 'pending':
      return 'Not written yet';
    case 'summarising':
      return 'Writing…';
    case 'scripted':
      return chapter.error === 'word_budget'
        ? `Summary ready · audio not generated · short summary (${chapter.wordCount} words)`
        : 'Summary ready · audio not generated';
    case 'synthesising':
      return 'Recording…';
    case 'ready':
      return `Ready · ${formatDuration(chapter.durationMs)}`;
    case 'failed':
      return chapter.error ?? 'Generation failed';
    default:
      return chapter.status;
  }
}

export default function FullGuideScreen() {
  const { guideId } = useLocalSearchParams<{ guideId: string }>();
  const { palette } = useTheme();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setTick((value) => value + 1);
    }, []),
  );

  const state = useAsync(async () => {
    const guide = await getGuide(guideId);
    if (!guide) return { guide: null } as const;
    const [book, chapters, stats] = await Promise.all([
      getBook(guide.bookId),
      listGuideChapters(guide.id),
      guideStats(guide.id),
    ]);
    return { guide, book, chapters, stats } as const;
  }, [guideId, tick]);

  const running = isGuideRunning(guideId);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (state.loading) {
    return (
      <Screen>
        <Header title="Full guide" onBack={() => router.back()} />
        <LoadingBlock label="Opening the guide…" />
      </Screen>
    );
  }

  if (!state.data?.guide) {
    return (
      <Screen>
        <Header title="Full guide" onBack={() => router.back()} />
        <EmptyState
          icon="reader-outline"
          title="This guide is gone"
          body="It may have been deleted."
          actionLabel="Go back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const { guide, book, chapters, stats } = state.data;
  const allHaveSummary =
    chapters.length > 0 && chapters.every((chapter) => !!chapter.summaryMd?.trim());
  const degraded = chapters.some((chapter) => (chapter.provider ?? '').endsWith('+extract'));
  const failedChapterIds = chapters
    .filter((chapter) => chapter.status === 'failed')
    .map((chapter) => chapter.id);
  const listeningProgress = stats.chapters ? stats.completed / stats.chapters : 0;
  const generationProgress = stats.chapters ? stats.ready / stats.chapters : 0;
  const interrupted = guide.status === 'generating' && !running;

  const generate = (chapterIds?: string[]) => {
    void startGuideGeneration({ guideId, mode: 'all', chapterIds });
    setTick((value) => value + 1);
  };

  const cancel = () => {
    void cancelGuideGeneration(guideId);
    setTick((value) => value + 1);
  };

  const toggleDone = (chapter: GuideChapter) => {
    void (async () => {
      if (chapter.completedAt !== null) await uncompleteGuideChapter(chapter.id);
      else await completeGuideChapter(chapter.id);
      setTick((value) => value + 1);
    })();
  };

  const download = async () => {
    if (!book) return;
    setBusy('pdf');
    setError(null);
    try {
      const uri = await writeFullGuidePdf({
        guide,
        bookTitle: book.title,
        author: book.author ?? null,
        chapters,
        generatedAt: Date.now(),
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          UTI: 'com.adobe.pdf',
          dialogTitle: 'Freehaven full guide',
        });
      } else {
        setError('Sharing is not available on this device.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Header
        title="Full guide"
        subtitle={book?.title ?? guide.title}
        onBack={() => router.back()}
        right={<BrandLockup height={36} />}
      />

      <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
        <AppText variant="label" muted>
          {book?.title ?? guide.title}
        </AppText>
        <AppText variant="caption" muted style={{ marginTop: 4 }}>
          {stats.ready}/{stats.chapters} chapters ready · {stats.completed}/{stats.chapters}{' '}
          listened
        </AppText>
        <AppText variant="caption" faint style={{ marginTop: 2 }}>
          {stats.words.toLocaleString('en-US')} words ·{' '}
          {Math.round(stats.durationMs / 60_000)} min of audio
        </AppText>
        <ProgressBar value={listeningProgress} height={8} style={{ marginTop: space.md }} />
        {stats.ready < stats.chapters ? (
          <>
            <AppText variant="caption" faint style={{ marginTop: space.sm }}>
              {stats.ready}/{stats.chapters} generated
            </AppText>
            <ProgressBar value={generationProgress} height={4} style={{ marginTop: 4 }} />
          </>
        ) : null}
        {stats.streakDays > 0 ? (
          <AppText variant="caption" color={palette.warm} style={{ marginTop: space.sm }}>
            {stats.streakDays}-day guide streak
          </AppText>
        ) : null}

        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: space.sm,
            marginTop: space.md,
          }}
        >
          <Button
            label="Download PDF"
            icon="download-outline"
            size="sm"
            loading={busy === 'pdf'}
            disabled={!allHaveSummary}
            onPress={() => void download()}
          />
          {stats.ready < stats.chapters ? (
            <Button
              label="Generate remaining"
              icon="cloud-download-outline"
              variant="secondary"
              size="sm"
              onPress={() => generate()}
            />
          ) : null}
          {running ? (
            <Button label="Cancel" variant="ghost" size="sm" onPress={cancel} />
          ) : null}
          {failedChapterIds.length > 0 ? (
            <Button
              label="Retry failed"
              icon="refresh-outline"
              variant="secondary"
              size="sm"
              onPress={() => generate(failedChapterIds)}
            />
          ) : null}
        </View>
      </Card>

      {interrupted ? (
        <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.line }}>
          <AppText variant="bodySm" style={{ fontWeight: '600' }}>
            Interrupted
          </AppText>
          <AppText variant="caption" muted style={{ marginTop: 4 }}>
            Generation stopped before it finished. Finished chapters are kept, so a resume only
            writes what is missing.
          </AppText>
          <View style={{ marginTop: space.md }}>
            <Button
              label="Resume generation"
              icon="refresh-outline"
              size="sm"
              onPress={() => generate()}
            />
          </View>
        </Card>
      ) : null}

      {degraded ? (
        <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.line }}>
          <AppText variant="bodySm" muted>
            Part of this guide used an on-device extract because the model returned an empty
            response. Generate the chapter again for a full model summary.
          </AppText>
        </Card>
      ) : null}

      {error ? (
        <AppText variant="caption" color={palette.danger}>
          {error}
        </AppText>
      ) : null}

      <Divider />

      <View style={{ gap: space.sm }}>
        <AppText variant="heading" serif>
          Chapters
        </AppText>
        {chapters.map((chapter) => {
          const ready = chapter.status === 'ready';
          const cleanTitle = stripChapterNumber(chapter.title) || chapter.title;
          const excerpt = summaryExcerpt(chapter.summaryMd);
          return (
            <Card key={chapter.id} style={{ paddingVertical: space.md }}>
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
                  <AppText
                    variant="caption"
                    color={palette.accent}
                    style={{ fontWeight: '700' }}
                  >
                    {chapter.ordinal + 1}
                  </AppText>
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <AppText variant="bodySm" serif numberOfLines={2} style={{ fontWeight: '600' }}>
                    {cleanTitle}
                  </AppText>
                  <AppText variant="caption" faint>
                    ~{chapter.wordCount.toLocaleString('en-US')} words
                    {chapter.durationMs ? ` · ${formatDuration(chapter.durationMs)}` : ''}
                  </AppText>
                  {excerpt ? (
                    <AppText variant="caption" muted numberOfLines={3}>
                      {excerpt}
                    </AppText>
                  ) : null}
                  <AppText
                    variant="caption"
                    color={
                      chapter.status === 'failed'
                        ? palette.danger
                        : ready
                          ? palette.accent
                          : palette.inkMuted
                    }
                  >
                    {chapterStatusLine(chapter)}
                  </AppText>
                  <View
                    style={{
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      gap: space.sm,
                      marginTop: space.sm,
                    }}
                  >
                    {ready ? (
                      <Button
                        label="Play"
                        icon="play"
                        size="sm"
                        onPress={() =>
                          router.push({
                            pathname: '/listen/[id]',
                            params: { id: guide.bookId, guideChapter: chapter.id },
                          })
                        }
                      />
                    ) : (
                      <Button
                        label={chapter.status === 'failed' ? 'Retry' : 'Generate'}
                        icon="sparkles-outline"
                        size="sm"
                        onPress={() => generate([chapter.id])}
                      />
                    )}
                    {chapter.summaryMd ? (
                      <Button
                        label={chapter.completedAt !== null ? 'Mark not done' : 'Mark done'}
                        icon={
                          chapter.completedAt !== null
                            ? 'checkmark-done-outline'
                            : 'checkmark-circle'
                        }
                        variant="secondary"
                        size="sm"
                        onPress={() => toggleDone(chapter)}
                      />
                    ) : null}
                  </View>
                </View>
              </View>
            </Card>
          );
        })}
      </View>

      <AppText variant="caption" faint>
        Generated from the text on this device. Always verify against the source.
      </AppText>
    </Screen>
  );
}
