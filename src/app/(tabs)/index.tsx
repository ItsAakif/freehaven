import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { Icon } from '@/design/icon';
import { Screen, AppText, Card, Button, Cover, ProgressBar, SectionHeader, IconButton, Reveal, EmptyState } from '@/design/ui';
import { radius, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { countLibrary, listRecentBooks } from '@/data/repositories/books';
import { getReadingPosition, listHighlightsWithBooks } from '@/data/repositories/reading';
import { dueCount, listRecentSummaries, reviewStats } from '@/data/repositories/learning';
import { guideForToday, type TodayGuide } from '@/data/repositories/guides';
import { searchCatalogue } from '@/providers/catalogue';
import { getProfile, type Profile } from '@/data/repositories/profile';
import { minutesToday } from '@/data/repositories/activity';
import type { Book } from '@/domain/types';
import type { CatalogueBook } from '@/providers/catalogue/types';

type TodayData = {
  libraryCount: number;
  continueBook: { book: Book; percent: number; section?: string | null } | null;
  due: number;
  streak: number;
  reviewedToday: number;
  week: number[];
  notes: { id: string; quote: string; bookTitle: string }[];
  summaries: { id: string; title: string; bookTitle: string; kind: string }[];
  picks: CatalogueBook[];
  profile: Profile;
  minutes: number;
  guideToday: TodayGuide | null;
};

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function chapterDuration(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** Calm daily-path card. One guide at a time, paced by `chapters_per_day`. */
function GuideTodayCard({ guideToday }: { guideToday: TodayGuide }) {
  const { palette } = useTheme();

  if (guideToday.kind === 'next') {
    const { chapter, guide, bookTitle, total, done } = guideToday;
    const duration = chapterDuration(chapter.durationMs);
    return (
      <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
        <AppText variant="label" muted>
          TODAY’S CHAPTER
        </AppText>
        <AppText variant="title" serif style={{ marginTop: 2 }} numberOfLines={2}>
          {chapter.title}
        </AppText>
        <AppText variant="caption" muted style={{ marginTop: 4 }}>
          {bookTitle} · Chapter {chapter.ordinal + 1} of {total}
          {duration ? ` · ${duration}` : ''}
        </AppText>
        <ProgressBar value={total ? done / total : 0} style={{ marginTop: space.md }} />
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: space.sm,
          }}
        >
          <AppText variant="caption" faint>
            {done}/{total} chapters
          </AppText>
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
        </View>
      </Card>
    );
  }

  if (guideToday.kind === 'done_today') {
    const { guide, next, total, done, streakDays } = guideToday;
    return (
      <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
        <AppText variant="label" muted>
          FULL GUIDE
        </AppText>
        <AppText variant="title" serif style={{ marginTop: 2 }}>
          Today’s chapter is done
        </AppText>
        <AppText variant="caption" muted style={{ marginTop: 4 }}>
          {next ? `Next: ${next.title} · tomorrow` : 'More chapters are still generating'}
        </AppText>
        <ProgressBar value={total ? done / total : 0} style={{ marginTop: space.md }} />
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: space.sm,
          }}
        >
          <AppText variant="caption" faint>
            {done}/{total} chapters
            {streakDays > 0 ? ` · ${streakDays}-day streak` : ''}
          </AppText>
          <Button
            label="Open guide"
            variant="secondary"
            size="sm"
            onPress={() =>
              router.push({ pathname: '/full-guide/[guideId]', params: { guideId: guide.id } })
            }
          />
        </View>
      </Card>
    );
  }

  const { guide, total, streakDays } = guideToday;
  return (
    <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.accentSoft }}>
      <AppText variant="label" muted>
        FULL GUIDE
      </AppText>
      <AppText variant="title" serif style={{ marginTop: 2 }}>
        Full guide complete
      </AppText>
      <AppText variant="caption" muted style={{ marginTop: 4 }}>
        {total} chapters{streakDays > 0 ? ` · ${streakDays}-day streak` : ''}
      </AppText>
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
        <Button
          label="Open guide"
          size="sm"
          onPress={() =>
            router.push({ pathname: '/full-guide/[guideId]', params: { guideId: guide.id } })
          }
        />
        <Button
          label="Download PDF"
          icon="download-outline"
          variant="secondary"
          size="sm"
          onPress={() =>
            router.push({ pathname: '/full-guide/[guideId]', params: { guideId: guide.id } })
          }
        />
      </View>
    </Card>
  );
}

export default function TodayScreen() {
  const { palette } = useTheme();
  const [tick, setTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setTick((t) => t + 1);
    }, []),
  );

  const state = useAsync<TodayData>(async () => {
    const [libraryCount, recent, due, stats, notes, summaries] = await Promise.all([
      countLibrary(),
      listRecentBooks(8),
      dueCount(),
      reviewStats(),
      listHighlightsWithBooks(),
      listRecentSummaries(3),
    ]);
    const [profile, minutes, guideToday] = await Promise.all([
      getProfile(),
      minutesToday(),
      guideForToday(),
    ]);

    let continueBook: TodayData['continueBook'] = null;
    for (const book of recent) {
      const pos = await getReadingPosition(book.id);
      if (pos && pos.percent > 0 && pos.percent < 1) {
        continueBook = { book, percent: pos.percent, section: pos.sectionTitle };
        break;
      }
    }

    let picks: CatalogueBook[] = [];
    try {
      const result = await searchCatalogue({}, ['gutendex']);
      picks = result.books.slice(0, 8);
    } catch {
      picks = [];
    }

    return {
      libraryCount,
      continueBook,
      due,
      streak: stats.streakDays,
      reviewedToday: stats.reviewedToday,
      week: stats.last7Days,
      notes: notes.slice(0, 3).map((n) => ({ id: n.id, quote: n.quote, bookTitle: n.bookTitle })),
      summaries: summaries.map((s) => ({ id: s.id, title: s.title, bookTitle: s.bookTitle, kind: s.kind })),
      picks,
      profile,
      minutes,
      guideToday,
    };
  }, [tick]);

  if (state.data && !state.data.profile.onboardingComplete) {
    return <Redirect href="/onboarding" />;
  }

  const data = state.data;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const maxWeek = Math.max(1, ...(data?.week ?? [1]));
  const greetingText = data?.profile.displayName
    ? `${greeting()}, ${data.profile.displayName}`
    : greeting();

  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: space.sm }}>
        <View style={{ flex: 1 }}>
          <AppText variant="caption" faint style={{ textTransform: 'uppercase', letterSpacing: 1.4 }}>
            {today}
          </AppText>
          <AppText variant="display" serif style={{ marginTop: 2 }}>
            {greetingText}
          </AppText>
          <AppText variant="bodySm" muted style={{ marginTop: 4 }}>
            {data?.streak
              ? `${data.streak}-day streak · ${data.reviewedToday} reviews today`
              : 'A quiet place to learn from what you read.'}
          </AppText>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <IconButton name="library-outline" label="Your library" onPress={() => router.push('/library')} />
          <IconButton name="search" label="Browse the catalogue" onPress={() => router.push('/browse')} />
          <IconButton name="settings-outline" label="Settings" onPress={() => router.push('/settings')} />
        </View>
      </View>

      <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <View>
            <AppText variant="label" muted>
              TODAY’S TARGET
            </AppText>
            <AppText variant="heading" serif style={{ marginTop: 2 }}>
              {Math.round(data?.minutes ?? 0)} / {data?.profile.minutesPerDay ?? 15} min
            </AppText>
          </View>
          <Pressable
            onPress={() => router.push('/settings')}
            accessibilityRole="button"
            accessibilityLabel="Change daily target"
            hitSlop={8}
          >
            <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
              Adjust
            </AppText>
          </Pressable>
        </View>
        <ProgressBar
          value={Math.min(1, (data?.minutes ?? 0) / Math.max(1, data?.profile.minutesPerDay ?? 15))}
          style={{ marginTop: space.sm }}
        />
        <AppText variant="caption" faint style={{ marginTop: 6 }}>
          {data?.profile.goal
            ? `Working toward: ${data.profile.goal}`
            : 'Reading and reviews both count toward the target.'}
        </AppText>
      </Card>

      {state.error ? (
        <Card style={{ borderColor: palette.dangerSoft, backgroundColor: palette.dangerSoft }}>
          <AppText variant="bodySm" color={palette.danger}>
            {state.error}
          </AppText>
        </Card>
      ) : null}

      {!state.loading && data?.libraryCount === 0 ? (
        <Reveal>
          <Card style={{ backgroundColor: palette.accent, borderColor: palette.accent, padding: space.xl }}>
            <AppText variant="caption" color={palette.accentInk} style={{ opacity: 0.75, letterSpacing: 1.2 }}>
              START HERE
            </AppText>
            <AppText variant="title" serif color={palette.accentInk} style={{ marginTop: 6 }}>
              Bring your own books
            </AppText>
            <AppText variant="bodySm" color={palette.accentInk} style={{ opacity: 0.85, marginTop: 6 }}>
              Import a PDF or EPUB, or start with a free public-domain classic. Everything works offline.
            </AppText>
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg, flexWrap: 'wrap' }}>
              <Button label="Import a file" icon="cloud-upload-outline" onPress={() => router.push('/import')} variant="secondary" />
              <Button label="Browse classics" icon="library-outline" onPress={() => router.push('/browse')} variant="ghost" />
            </View>
          </Card>
        </Reveal>
      ) : null}

      {data?.continueBook ? (
        <Reveal delay={40}>
          <SectionHeader title="Continue" />
          <Card onPress={() => router.push({ pathname: '/read/[id]', params: { id: data.continueBook!.book.id } })} style={{ marginTop: space.sm }}>
            <View style={{ flexDirection: 'row', gap: space.lg }}>
              <Cover uri={data.continueBook.book.coverUrl} title={data.continueBook.book.title} width={66} height={96} />
              <View style={{ flex: 1, justifyContent: 'space-between', gap: space.sm }}>
                <View>
                  <AppText variant="subheading" serif numberOfLines={2}>
                    {data.continueBook.book.title}
                  </AppText>
                  <AppText variant="caption" muted numberOfLines={1}>
                    {data.continueBook.book.author ?? 'Unknown author'}
                    {data.continueBook.section ? ` · ${data.continueBook.section}` : ''}
                  </AppText>
                </View>
                <View style={{ gap: 6 }}>
                  <ProgressBar value={data.continueBook.percent} />
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <AppText variant="caption" faint>
                      {Math.round(data.continueBook.percent * 100)}% read
                    </AppText>
                    <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
                      Resume →
                    </AppText>
                  </View>
                </View>
              </View>
            </View>
          </Card>
        </Reveal>
      ) : null}

      {data?.guideToday ? (
        <Reveal delay={50}>
          <GuideTodayCard guideToday={data.guideToday} />
        </Reveal>
      ) : null}

      <Reveal delay={60}>
        <Card
          style={{
            backgroundColor: data?.due ? palette.surface : palette.surfaceAlt,
            marginTop: space.md,
          }}
          onPress={() => router.push('/review')}
          accessibilityLabel={data?.due ? `${data.due} cards due for review` : 'Review queue empty'}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View
              style={{
                width: 46,
                height: 46,
                borderRadius: radius.md,
                backgroundColor: data?.due ? palette.accentSoft : palette.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name={data?.due ? 'albums' : 'checkmark-done'} size={22} color={data?.due ? palette.accent : palette.inkMuted} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="subheading" serif>
                {data?.due ? `${data.due} card${data.due === 1 ? '' : 's'} to review` : 'Review queue clear'}
              </AppText>
              <AppText variant="caption" muted>
                {data?.due ? 'Spaced repetition, scheduled on device.' : 'New cards appear here after you make them.'}
              </AppText>
            </View>
            <Icon name="chevron-forward" size={18} color={palette.inkFaint} />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 42, marginTop: space.lg }}>
            {(data?.week ?? Array(7).fill(0)).map((count, i) => (
              <View key={i} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
                <View
                  style={{
                    width: '100%',
                    height: Math.max(4, (count / maxWeek) * 34),
                    borderRadius: 4,
                    backgroundColor: count ? palette.accent : palette.line,
                    opacity: count ? 0.9 : 0.7,
                  }}
                />
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <AppText key={`${d}${i}`} variant="caption" faint style={{ flex: 1, textAlign: 'center' }}>
                {d}
              </AppText>
            ))}
          </View>
        </Card>
      </Reveal>

      {data?.picks.length ? (
        <Reveal delay={80}>
          <SectionHeader title="Free classics" actionLabel="Browse" onAction={() => router.push('/browse')} style={{ marginTop: space.lg }} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md, paddingVertical: space.sm }}>
            {data.picks.map((pick) => (
              <Pressable
                key={pick.id}
                onPress={() => router.push({ pathname: '/book/[id]', params: { id: pick.id, provider: pick.provider } })}
                accessibilityRole="button"
                accessibilityLabel={`${pick.title} by ${pick.author ?? 'unknown author'}`}
                style={{ width: 104 }}
              >
                <Cover uri={pick.coverUrl} title={pick.title} width={104} height={150} />
                <AppText variant="caption" numberOfLines={2} style={{ marginTop: 6, fontWeight: '600' }}>
                  {pick.title}
                </AppText>
                <AppText variant="caption" faint numberOfLines={1}>
                  {pick.author ?? 'Unknown'}
                </AppText>
              </Pressable>
            ))}
          </ScrollView>
        </Reveal>
      ) : null}

      {data?.notes.length ? (
        <Reveal delay={100}>
          <SectionHeader title="From your notes" actionLabel="Mindspace" onAction={() => router.push('/mindspace')} style={{ marginTop: space.lg }} />
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {data.notes.map((note) => (
              <Card key={note.id} style={{ paddingVertical: space.md }}>
                <AppText variant="bodySm" serif numberOfLines={3}>
                  “{note.quote}”
                </AppText>
                <AppText variant="caption" faint style={{ marginTop: 6 }}>
                  {note.bookTitle}
                </AppText>
              </Card>
            ))}
          </View>
        </Reveal>
      ) : null}

      {data?.summaries.length ? (
        <Reveal delay={120}>
          <SectionHeader title="Recent lessons" style={{ marginTop: space.lg }} />
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {data.summaries.map((summary) => (
              <Card
                key={summary.id}
                onPress={() => router.push({ pathname: '/summary/[id]', params: { id: summary.id } })}
                style={{ paddingVertical: space.md }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Icon name="document-text-outline" size={18} color={palette.accent} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySm" numberOfLines={1} style={{ fontWeight: '600' }}>
                      {summary.title}
                    </AppText>
                    <AppText variant="caption" faint numberOfLines={1}>
                      {summary.bookTitle} · {summary.kind}
                    </AppText>
                  </View>
                  <Icon name="chevron-forward" size={16} color={palette.inkFaint} />
                </View>
              </Card>
            ))}
          </View>
        </Reveal>
      ) : null}

      {!state.loading && (data?.libraryCount ?? 0) > 0 && !data?.continueBook ? (
        <View style={{ marginTop: space.lg }}>
          <EmptyState
            icon="book-outline"
            title="Pick up something new"
            body="Your library is ready. Open a book to start reading, or import a document of your own."
            actionLabel="Open library"
            onAction={() => router.push('/browse')}
          />
        </View>
      ) : null}
    </Screen>
  );
}
