import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  AppText,
  Card,
  Cover,
  Button,
  Chip,
  Header,
  ProgressBar,
  SectionHeader,
  Divider,
  LoadingBlock,
  ErrorState,
  EmptyState,
  Sheet,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { getBook, setInLibrary } from '@/data/repositories/books';
import { getDocument, getReadingPosition, listHighlights, listSections } from '@/data/repositories/reading';
import { listCards, listSummaries } from '@/data/repositories/learning';
import { downloadGutenbergBook } from '@/features/imports/service';
import { conceptSummary, generateCardsForBook, summariseBook, summariseChapter } from '@/features/learning/generate';
import { bookMastery } from '@/data/repositories/mastery';
import { formatMinutes } from '@/lib/id';

export default function BookDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genKind, setGenKind] = useState<'summary' | 'takeaways' | 'lesson' | 'chapter' | 'concepts'>('summary');
  const [genLength, setGenLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [chapterId, setChapterId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setTick((t) => t + 1);
    }, []),
  );

  const state = useAsync(async () => {
    const book = await getBook(id);
    if (!book) return { book: null } as const;
    const [document, position, summaries, cards, highlights] = await Promise.all([
      getDocument(book.id),
      getReadingPosition(book.id),
      listSummaries(book.id),
      listCards(book.id),
      listHighlights(book.id),
    ]);
    const [sections, mastery] = await Promise.all([
      document ? listSections(document.id) : Promise.resolve([]),
      bookMastery(book.id),
    ]);
    return { book, document, position, summaries, cards, highlights, sections, mastery } as const;
  }, [id, tick]);

  if (state.loading) {
    return (
      <Screen>
        <Header title="Book" onBack={() => router.back()} />
        <LoadingBlock />
      </Screen>
    );
  }

  if (!state.data?.book) {
    return (
      <Screen>
        <Header title="Book" onBack={() => router.back()} />
        <EmptyState icon="alert-circle-outline" title="Book not found" body="It may have been removed from your library." />
      </Screen>
    );
  }

  const { book, document, position, summaries, cards, highlights, sections, mastery } = state.data;
  const readMinutes = document ? Math.max(1, Math.round((document.wordCount ?? 0) / 220)) : null;
  const canRead = !!document || (book.access === 'public_domain' && !!book.epubUrl);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    run('generate', async () => {
      if (genKind === 'chapter') {
        if (!chapterId) throw new Error('Choose a chapter first.');
        const result = await summariseChapter(book.id, chapterId, genLength);
        router.push({ pathname: '/summary/[id]', params: { id: result.summaryId } });
        return;
      }
      if (genKind === 'concepts') {
        const result = await conceptSummary(book.id);
        router.push({ pathname: '/summary/[id]', params: { id: result.summaryId } });
        return;
      }
      const result = await summariseBook(book.id, genKind, genLength);
      router.push({ pathname: '/summary/[id]', params: { id: result.summaryId } });
    });

  const startReading = () =>
    run('opening', async () => {
      if (document) {
        router.push({ pathname: '/read/[id]', params: { id: book.id } });
        return;
      }
      if (book.epubUrl) {
        await downloadGutenbergBook(book.id, book.epubUrl);
        setTick((t) => t + 1);
        router.push({ pathname: '/read/[id]', params: { id: book.id } });
        return;
      }
      throw new Error('No readable file is available for this title. Use the access link to find a copy.');
    });

  return (
    <Screen>
      <Header title="" onBack={() => router.back()} />

      <View style={{ flexDirection: 'row', gap: space.lg }}>
        <Cover uri={book.coverUrl} title={book.title} width={118} height={172} />
        <View style={{ flex: 1, gap: 6 }}>
          <AppText variant="title" serif>
            {book.title}
          </AppText>
          <AppText variant="bodySm" muted>
            {book.author ?? 'Unknown author'}
          </AppText>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <Chip label={book.access === 'public_domain' ? 'Public domain' : book.access === 'user_import' ? 'Your copy' : book.access === 'preview' ? 'Preview' : 'Access link'} active />
          </View>
          <AppText variant="caption" faint style={{ marginTop: 4 }}>
            {[
              book.publishedYear,
              book.publisher,
              book.pageCount ? `${book.pageCount} pages` : null,
              readMinutes ? `~${formatMinutes(readMinutes)} read` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </AppText>
        </View>
      </View>

      {error ? <ErrorState message={error} /> : null}

      {position && position.percent > 0 ? (
        <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <AppText variant="caption" muted>
              {position.sectionTitle ?? 'Reading'}
            </AppText>
            <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
              {Math.round(position.percent * 100)}%
            </AppText>
          </View>
          <ProgressBar value={position.percent} />
        </Card>
      ) : null}

      {mastery.cards > 0 ? (
        <AppText variant="caption" faint>
          Mastery: {mastery.mature}/{mastery.cards} mature · {mastery.due} due · average stability{' '}
          {mastery.avgStability.toFixed(1)} days
          {mastery.lastReviewedAt ? ` · last reviewed ${new Date(mastery.lastReviewedAt).toLocaleDateString()}` : ''}
        </AppText>
      ) : null}

      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button
          label={document ? 'Read' : 'Download & read'}
          icon="book-outline"
          onPress={() => void startReading()}
          loading={busy === 'opening'}
          disabled={!canRead}
        />
        <Button
          label="Listen"
          icon="headset-outline"
          variant="secondary"
          disabled={!document}
          onPress={() => router.push({ pathname: '/listen/[id]', params: { id: book.id } })}
        />
        <Button
          label="Ask"
          icon="chatbubble-ellipses-outline"
          variant="secondary"
          disabled={!document}
          onPress={() => router.push({ pathname: '/chat/[id]', params: { id: book.id } })}
        />
        <Button
          label={book.inLibrary ? 'Saved' : 'Save'}
          icon={book.inLibrary ? 'checkmark' : 'bookmark-outline'}
          variant="ghost"
          onPress={() =>
            void run('library', async () => {
              await setInLibrary(book.id, !book.inLibrary);
              setTick((t) => t + 1);
            })
          }
          loading={busy === 'library'}
        />
      </View>

      {book.description ? (
        <View style={{ gap: 6 }}>
          <SectionHeader title="About" />
          <AppText variant="bodySm" muted>
            {book.description}
          </AppText>
        </View>
      ) : null}

      <Divider />

      <SectionHeader title="Make something" />
      <AppText variant="caption" faint style={{ marginBottom: space.sm }}>
        Generated from the text you can lawfully open. You can edit or delete everything afterwards.
      </AppText>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button
          label="Generate"
          icon="sparkles-outline"
          variant="secondary"
          size="sm"
          disabled={!document}
          onPress={() => setGenOpen(true)}
        />
        <Button
          label="Build cards"
          icon="albums-outline"
          variant="secondary"
          size="sm"
          loading={busy === 'cards'}
          disabled={!document || !!busy}
          onPress={() =>
            void run('cards', async () => {
              const created = await generateCardsForBook(book.id, 10);
              setTick((t) => t + 1);
              router.push('/review');
              return created;
            })
          }
        />
      </View>

      {cards.length ? (
        <Card onPress={() => router.push('/review')} style={{ paddingVertical: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Ionicons name="albums-outline" size={18} color={palette.accent} />
            <AppText variant="bodySm" style={{ flex: 1 }}>
              {cards.length} card{cards.length === 1 ? '' : 's'} from this book
            </AppText>
            <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
              Review →
            </AppText>
          </View>
        </Card>
      ) : null}

      {summaries.length ? (
        <View style={{ gap: space.sm }}>
          <AppText variant="label" muted>
            Generated
          </AppText>
          {summaries.map((summary) => (
            <Card
              key={summary.id}
              onPress={() => router.push({ pathname: '/summary/[id]', params: { id: summary.id } })}
              style={{ paddingVertical: space.md }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <Ionicons name="reader-outline" size={18} color={palette.warm} />
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySm" numberOfLines={1} style={{ fontWeight: '600' }}>
                    {summary.title}
                  </AppText>
                  <AppText variant="caption" faint>
                    {summary.provider} · {new Date(summary.createdAt).toLocaleDateString()}
                  </AppText>
                </View>
                <Ionicons name="chevron-forward" size={16} color={palette.inkFaint} />
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {highlights.length ? (
        <View style={{ gap: 6 }}>
          <AppText variant="label" muted>
            {highlights.length} highlight{highlights.length === 1 ? '' : 's'}
          </AppText>
          {highlights.slice(0, 3).map((highlight) => (
            <Card key={highlight.id} style={{ paddingVertical: space.sm }}>
              <AppText variant="caption" numberOfLines={2}>
                “{highlight.quote}”
              </AppText>
            </Card>
          ))}
        </View>
      ) : null}

      {book.externalUrl || book.epubUrl ? (
        <View style={{ gap: space.sm }}>
          <Divider />
          <AppText variant="caption" faint>
            {book.license ?? 'Licence information is provided by the catalogue.'}
          </AppText>
          {book.externalUrl ? (
            <Button
              label="Open official source"
              icon="open-outline"
              variant="ghost"
              size="sm"
              onPress={() => void WebBrowser.openBrowserAsync(book.externalUrl!)}
            />
          ) : null}
        </View>
      ) : null}

      <Sheet visible={genOpen} onClose={() => setGenOpen(false)} title="Generate from this book">
        <AppText variant="label" muted>
          What should it be?
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {(
            [
              { id: 'summary', label: 'Summary' },
              { id: 'takeaways', label: 'Takeaways' },
              { id: 'lesson', label: 'Lesson' },
              { id: 'concepts', label: 'Concepts' },
              { id: 'chapter', label: 'Chapter' },
            ] as const
          ).map((option) => (
            <Chip
              key={option.id}
              label={option.label}
              active={genKind === option.id}
              onPress={() => {
                setGenKind(option.id);
                if (option.id === 'chapter' && !chapterId && sections[0]) setChapterId(sections[0].id);
              }}
            />
          ))}
        </View>

        {genKind === 'chapter' ? (
          <View style={{ gap: space.sm }}>
            <AppText variant="label" muted>
              Chapter
            </AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {sections.slice(0, 24).map((section, i) => (
                <Chip
                  key={section.id}
                  label={section.title ? section.title.slice(0, 26) : `Section ${i + 1}`}
                  active={chapterId === section.id}
                  onPress={() => setChapterId(section.id)}
                />
              ))}
            </View>
            {sections.length > 24 ? (
              <AppText variant="caption" faint>
                Showing the first 24 sections. Use the reader’s contents sheet for the full list.
              </AppText>
            ) : null}
          </View>
        ) : null}

        <AppText variant="label" muted>
          Length
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {(['short', 'medium', 'long'] as const).map((option) => (
            <Chip key={option} label={option[0].toUpperCase() + option.slice(1)} active={genLength === option} onPress={() => setGenLength(option)} />
          ))}
        </View>

        <Button
          label="Generate"
          icon="sparkles-outline"
          onPress={() => void generate()}
          loading={busy === 'generate'}
          disabled={busy === 'generate' || (genKind === 'chapter' && !chapterId)}
          full
        />
        <AppText variant="caption" faint>
          Everything is generated from the text you already have and cites its passages. On-device extraction is used
          unless you configured a remote model.
        </AppText>
      </Sheet>
    </Screen>
  );
}
