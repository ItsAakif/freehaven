import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/design/icon';
import {
  Screen,
  AppText,
  Card,
  Cover,
  Field,
  Chip,
  Button,
  EmptyState,
  LoadingBlock,
  ErrorState,
  SectionHeader,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useDatabase } from '@/data/DatabaseProvider';
import { searchLocalBooks, setInLibrary, upsertCatalogueBook } from '@/data/repositories/books';
import { searchCatalogue } from '@/providers/catalogue';
import type { CatalogueBook } from '@/providers/catalogue/types';
import type { Book } from '@/domain/types';

const PROVIDERS = [{ id: 'gutendex', label: 'Project Gutenberg' }] as const;

const SUGGESTIONS = ['stoicism', 'psychology', 'economics', 'science', 'philosophy', 'history'];

export default function BrowseScreen() {
  const params = useLocalSearchParams<{ subject?: string }>();
  const { palette } = useTheme();
  useDatabase();
  const [query, setQuery] = useState(params.subject ?? '');
  const [submitted, setSubmitted] = useState(params.subject ?? '');
  const [books, setBooks] = useState<CatalogueBook[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attribution, setAttribution] = useState('');
  const [local, setLocal] = useState<Book[]>([]);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const requestId = useRef(0);

  useEffect(() => {
    const handle = setTimeout(() => setSubmitted(query.trim()), 380);
    return () => clearTimeout(handle);
  }, [query]);

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      const id = ++requestId.current;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const result = await searchCatalogue(
          { q: submitted || undefined, subject: !submitted ? params.subject : undefined, page: nextPage, limit: 20 },
          [PROVIDERS[0].id],
        );
        if (id !== requestId.current) return;
        setBooks((prev) => (append ? [...prev, ...result.books] : result.books));
        setHasMore(result.books.length > 0 && nextPage < 20);
        setPage(nextPage);
        setAttribution(result.attributions[0] ?? '');
        if (result.failures.length) setError(result.failures[0].message);
      } catch (e) {
        if (id === requestId.current) setError((e as Error).message);
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [submitted, params.subject],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  useEffect(() => {
    let active = true;
    if (!submitted) {
      setLocal([]);
      return;
    }
    searchLocalBooks(submitted, 5)
      .then((rows) => active && setLocal(rows))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [submitted]);

  const openBook = async (candidate: CatalogueBook) => {
    await upsertCatalogueBook(candidate);
    router.push({ pathname: '/book/[id]', params: { id: candidate.id } });
  };

  const saveBook = async (candidate: CatalogueBook) => {
    await upsertCatalogueBook(candidate);
    await setInLibrary(candidate.id, true);
    setSaved((s) => ({ ...s, [candidate.id]: true }));
  };

  return (
    <Screen>
      <View style={{ paddingTop: space.sm, gap: 4 }}>
        <AppText variant="caption" faint style={{ textTransform: 'uppercase', letterSpacing: 1.4 }}>
          Browse
        </AppText>
        <AppText variant="display" serif>
          The catalogue
        </AppText>
      </View>

      <Field
        value={query}
        onChangeText={setQuery}
        placeholder="Title, author, ISBN or subject"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Search the catalogue"
        style={{ backgroundColor: palette.surface }}
      />

      {!submitted && !params.subject ? (
        <View style={{ gap: space.sm }}>
          <AppText variant="label" muted>
            Try a subject
          </AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {SUGGESTIONS.map((s) => (
              <Chip key={s} label={s} onPress={() => setQuery(s)} />
            ))}
          </View>
        </View>
      ) : null}

      {params.subject ? (
        <AppText variant="bodySm" muted>
          Browsing subject: <AppText variant="bodySm" style={{ fontWeight: '600' }}>{params.subject}</AppText>
        </AppText>
      ) : null}

      {local.length ? (
        <View style={{ gap: space.sm }}>
          <SectionHeader title="In your library" />
          {local.map((book) => (
            <Card
              key={book.id}
              onPress={() => router.push({ pathname: '/book/[id]', params: { id: book.id } })}
              style={{ paddingVertical: space.md }}
            >
              <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
                <Cover uri={book.coverUrl} title={book.title} width={40} height={58} />
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySm" numberOfLines={1} style={{ fontWeight: '600' }}>
                    {book.title}
                  </AppText>
                  <AppText variant="caption" faint numberOfLines={1}>
                    {book.author ?? 'Unknown'} · saved
                  </AppText>
                </View>
                <Icon name="bookmark" size={16} color={palette.accent} />
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {error ? <ErrorState message={error} onRetry={() => void load(1, false)} /> : null}

      {loading ? <LoadingBlock label={`Searching ${PROVIDERS[0].label}…`} /> : null}

      <View style={{ gap: space.md }}>
        {books.map((book) => (
          <Card key={book.id} onPress={() => void openBook(book)} accessibilityLabel={`${book.title} by ${book.author ?? 'unknown'}`}>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Cover uri={book.coverUrl} title={book.title} width={68} height={100} />
              <View style={{ flex: 1, gap: 4 }}>
                <AppText variant="subheading" serif numberOfLines={2}>
                  {book.title}
                </AppText>
                <AppText variant="caption" muted numberOfLines={1}>
                  {book.author ?? 'Unknown author'}
                  {book.publishedYear ? ` · ${book.publishedYear}` : ''}
                </AppText>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                  {book.epubUrl ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Icon name="download-outline" size={12} color={palette.accent} />
                      <AppText variant="caption" color={palette.accent} style={{ fontWeight: '600' }}>
                        Free EPUB · download
                      </AppText>
                    </View>
                  ) : (
                    <AppText variant="caption" faint>
                      {book.access === 'preview'
                        ? 'Preview at the source'
                        : book.access === 'external'
                          ? 'Open the source link'
                          : 'Catalogue record · open source link'}
                    </AppText>
                  )}
                  {book.pageCount ? <AppText variant="caption" faint>· {book.pageCount} pp</AppText> : null}
                </View>
                <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
                  <Button
                    label={saved[book.id] ? 'Saved' : 'Save'}
                    size="sm"
                    variant={saved[book.id] ? 'secondary' : 'ghost'}
                    icon={saved[book.id] ? 'checkmark' : 'bookmark-outline'}
                    onPress={() => void saveBook(book)}
                  />
                  <Button label="Details" size="sm" variant="secondary" onPress={() => void openBook(book)} />
                </View>
              </View>
            </View>
          </Card>
        ))}
      </View>

      {!loading && !error && books.length === 0 ? (
        <EmptyState
          icon="search-outline"
          title="No results yet"
          body={submitted ? `Nothing found for “${submitted}” in this catalogue. Try a broader term or a different spelling.` : 'Search for a title, an author, or a subject to begin.'}
        />
      ) : null}

      {books.length > 0 && hasMore ? (
        <Button
          label={loadingMore ? 'Loading…' : 'Load more'}
          variant="secondary"
          full
          loading={loadingMore}
          onPress={() => void load(page + 1, true)}
        />
      ) : null}

      {attribution ? (
        <AppText variant="caption" faint style={{ marginTop: space.md }}>
          {attribution}
        </AppText>
      ) : null}
    </Screen>
  );
}
