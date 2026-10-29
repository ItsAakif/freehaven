import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen, AppText, Card, Cover, SectionHeader, Reveal, Button } from '@/design/ui';
import { radius, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { searchCatalogue } from '@/providers/catalogue';
import type { CatalogueBook } from '@/providers/catalogue/types';
import { listLibrary, upsertCatalogueBook } from '@/data/repositories/books';
import { listPlans } from '@/data/repositories/learning';
import { getProfile } from '@/data/repositories/profile';
import type { Book } from '@/domain/types';

const ROWS = [
  { title: 'Philosophy', subject: 'philosophy', blurb: 'Stoics, ethics and first principles' },
  { title: 'Psychology', subject: 'psychology', blurb: 'Attention, habits and the mind' },
  { title: 'Science', subject: 'science', blurb: 'How the world actually works' },
];

type DiscoverData = {
  rows: { title: string; blurb: string; books: CatalogueBook[] }[];
  library: Book[];
  plans: { id: string; title: string; goal?: string | null; itemCount: number; doneCount: number }[];
  failures: number;
};

export default function DiscoverScreen() {
  const { palette } = useTheme();
  const [tick, setTick] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setTick((t) => t + 1);
    }, []),
  );

  const state = useAsync<DiscoverData>(async () => {
    const [library, plans, profile] = await Promise.all([listLibrary(), listPlans(), getProfile()]);
    const results = await Promise.allSettled(
      ROWS.map((row) => searchCatalogue({ subject: row.subject, limit: 8 }, ['gutendex'])),
    );
    const rows: DiscoverData['rows'] = [];
    let failures = 0;

    if (profile.topics.length) {
      try {
        const personal = await searchCatalogue({ subject: profile.topics[0], limit: 8 }, ['gutendex']);
        if (personal.books.length) {
          rows.push({
            title: 'For you',
            blurb: `Because you chose ${profile.topics[0]}${profile.familiarity[profile.topics[0]] === 'new' ? ' as a new subject' : ''}`,
            books: personal.books.slice(0, 8),
          });
        }
      } catch {
        failures += 1;
      }
    }

    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.books.length) {
        rows.push({ title: ROWS[i].title, blurb: ROWS[i].blurb, books: result.value.books.slice(0, 8) });
      } else {
        failures += 1;
      }
    });
    return { rows, library: library.slice(0, 6), plans, failures };
  }, [tick]);

  const openCatalogue = async (book: CatalogueBook) => {
    setOpening(book.id);
    try {
      await upsertCatalogueBook(book);
      router.push({ pathname: '/book/[id]', params: { id: book.id } });
    } finally {
      setOpening(null);
    }
  };

  return (
    <Screen>
      <View style={{ paddingTop: space.sm, gap: 4 }}>
        <AppText variant="caption" faint style={{ textTransform: 'uppercase', letterSpacing: 1.4 }}>
          Discover
        </AppText>
        <AppText variant="display" serif>
          Find your next idea
        </AppText>
        <AppText variant="bodySm" muted>
          Public-domain books you can read and listen to for free, plus paths built from them.
        </AppText>
      </View>

      {state.data?.plans.length ? (
        <Reveal>
          <SectionHeader title="Your learning paths" style={{ marginTop: space.lg }} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md, paddingVertical: space.sm }}>
            {state.data.plans.map((plan) => {
              const pct = plan.itemCount ? plan.doneCount / plan.itemCount : 0;
              return (
                <Card
                  key={plan.id}
                  onPress={() => router.push({ pathname: '/plan/[id]', params: { id: plan.id } })}
                  style={{ width: 240, backgroundColor: palette.accentSoft, borderColor: palette.accentSoft }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Ionicons name="map-outline" size={18} color={palette.accent} />
                    <AppText variant="caption" color={palette.accent}>
                      {Math.round(pct * 100)}%
                    </AppText>
                  </View>
                  <AppText variant="subheading" serif style={{ marginTop: space.sm }} numberOfLines={2}>
                    {plan.title}
                  </AppText>
                  <AppText variant="caption" muted numberOfLines={2} style={{ marginTop: 4 }}>
                    {plan.goal ?? 'A guided sequence of reads.'}
                  </AppText>
                  <AppText variant="caption" faint style={{ marginTop: space.sm }}>
                    {plan.doneCount}/{plan.itemCount} complete
                  </AppText>
                </Card>
              );
            })}
          </ScrollView>
        </Reveal>
      ) : null}

      <Reveal delay={40}>
        <Card
          onPress={() => router.push('/browse')}
          style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="sparkles-outline" size={20} color={palette.warm} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="subheading" serif>
                Build a path from a goal
              </AppText>
              <AppText variant="caption" muted>
                “Understand Stoicism” → a short, ordered reading list.
              </AppText>
            </View>
            <Ionicons name="chevron-forward" size={18} color={palette.inkFaint} />
          </View>
        </Card>
      </Reveal>

      {state.data?.rows.map((row, i) => (
        <Reveal key={row.title} delay={60 + i * 20}>
          <SectionHeader
            title={row.title}
            actionLabel="See all"
            onAction={() => router.push({ pathname: '/browse', params: { subject: row.title.toLowerCase() } })}
            style={{ marginTop: space.xl }}
          />
          <AppText variant="caption" faint style={{ marginTop: 2 }}>
            {row.blurb}
          </AppText>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md, paddingVertical: space.sm }}>
            {row.books.map((book) => (
              <Pressable
                key={book.id}
                onPress={() => void openCatalogue(book)}
                disabled={opening === book.id}
                accessibilityRole="button"
                accessibilityLabel={`${book.title} by ${book.author ?? 'unknown author'}`}
                style={{ width: 108, opacity: opening === book.id ? 0.6 : 1 }}
              >
                <Cover uri={book.coverUrl} title={book.title} width={108} height={156} />
                <AppText variant="caption" numberOfLines={2} style={{ marginTop: 6, fontWeight: '600' }}>
                  {book.title}
                </AppText>
                <AppText variant="caption" faint numberOfLines={1}>
                  {book.author ?? 'Unknown'}
                </AppText>
              </Pressable>
            ))}
          </ScrollView>
        </Reveal>
      ))}

      {state.data && state.data.rows.length === 0 ? (
        <Card style={{ marginTop: space.xl }}>
          <AppText variant="subheading" serif>
            Discovery needs a connection
          </AppText>
          <AppText variant="bodySm" muted style={{ marginTop: 6 }}>
            We could not reach the public catalogue just now. Your library, reader, notes and reviews keep working offline.
          </AppText>
          <View style={{ marginTop: space.md }}>
            <Button label="Try again" variant="secondary" size="sm" onPress={state.reload} />
          </View>
        </Card>
      ) : null}

      {state.data?.library.length ? (
        <Reveal delay={140}>
          <SectionHeader title="On your shelf" actionLabel="Library" onAction={() => router.push('/browse')} style={{ marginTop: space.xl }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.sm }}>
            {state.data.library.map((book) => (
              <Pressable
                key={book.id}
                onPress={() => router.push({ pathname: '/book/[id]', params: { id: book.id } })}
                accessibilityRole="button"
                accessibilityLabel={book.title}
                style={{ width: '30%' }}
              >
                <Cover uri={book.coverUrl} title={book.title} width={100} height={144} style={{ width: '100%' }} />
                <AppText variant="caption" numberOfLines={2} style={{ marginTop: 6 }}>
                  {book.title}
                </AppText>
              </Pressable>
            ))}
          </View>
        </Reveal>
      ) : null}

      <View style={{ marginTop: space.xl }}>
        <AppText variant="caption" faint>
          Catalogue metadata from Project Gutenberg and Open Library. Freehaven hosts only public-domain texts; other
          titles link to their official source.
        </AppText>
      </View>
    </Screen>
  );
}
