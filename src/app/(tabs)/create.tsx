import React, { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Icon } from '@/design/icon';
import {
  Screen,
  AppText,
  Card,
  Cover,
  Button,
  Field,
  Sheet,
  EmptyState,
  SectionHeader,
  LoadingBlock,
} from '@/design/ui';
import { radius, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { attachTopics, listLibrary, upsertCatalogueBook } from '@/data/repositories/books';
import { getDocument } from '@/data/repositories/reading';
import { addPlanItem, createPlan, listActiveJobs, listPlans } from '@/data/repositories/learning';
import { rebuildPlanSequence } from '@/data/repositories/mastery';
import { getProfile } from '@/data/repositories/profile';
import { searchCatalogue } from '@/providers/catalogue';

const GOAL_TEMPLATES = [
  { title: 'Think more clearly', goal: 'stoicism practical philosophy', subject: 'philosophy' },
  { title: 'Understand my attention', goal: 'attention habits psychology', subject: 'psychology' },
  { title: 'Economics in five reads', goal: 'economics wealth', subject: 'economics' },
  { title: 'How science works', goal: 'scientific method science', subject: 'science' },
];

export default function CreateScreen() {
  const { palette } = useTheme();
  const [tick, setTick] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setTick((t) => t + 1);
    }, []),
  );

  const state = useAsync(async () => {
    const [library, jobs, plans] = await Promise.all([listLibrary(), listActiveJobs(), listPlans()]);
    const withDocs = await Promise.all(
      library.map(async (book) => ({ book, document: await getDocument(book.id) })),
    );
    return { library, withDocs, jobs, plans };
  }, [tick]);

  const buildPlan = async (title: string, goalText: string, subject?: string) => {
    setBuilding(true);
    setBuildError(null);
    try {
      const plan = await createPlan(title, goalText);
      const profile = await getProfile();
      const result = await searchCatalogue({ q: goalText, subject, limit: 5 }, ['gutendex']);
      let ordinal = 0;
      for (const candidate of result.books.slice(0, 5)) {
        const book = await upsertCatalogueBook(candidate);
        await attachTopics(book.id, [...profile.topics, ...(subject ? [subject] : [])]);
        await addPlanItem(plan.id, book.id, ordinal);
        ordinal += 1;
      }
      await rebuildPlanSequence(plan.id, profile);
      setSheetOpen(false);
      router.push({ pathname: '/plan/[id]', params: { id: plan.id } });
    } catch (e) {
      setBuildError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Screen>
      <View style={{ paddingTop: space.sm, gap: 4 }}>
        <AppText variant="caption" faint style={{ textTransform: 'uppercase', letterSpacing: 1.4 }}>
          Create
        </AppText>
        <AppText variant="display" serif>
          Make something yours
        </AppText>
        <AppText variant="bodySm" muted>
          Import a document, turn it into a lesson, or narrate it.
        </AppText>
      </View>

      <View style={{ flexDirection: 'row', gap: space.md }}>
        <Pressable
          onPress={() => router.push('/import')}
          accessibilityRole="button"
          accessibilityLabel="Import an EPUB or PDF"
          style={{ flex: 1 }}
        >
          <Card style={{ backgroundColor: palette.accent, borderColor: palette.accent, minHeight: 150 }}>
            <Icon name="cloud-upload-outline" size={26} color={palette.accentInk} />
            <AppText variant="heading" serif color={palette.accentInk} style={{ marginTop: space.md }}>
              Import
            </AppText>
            <AppText variant="caption" color={palette.accentInk} style={{ opacity: 0.8, marginTop: 4 }}>
              EPUB, PDF or plain text from your device.
            </AppText>
          </Card>
        </Pressable>
        <Pressable
          onPress={() => setSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Build a learning path"
          style={{ flex: 1 }}
        >
          <Card style={{ backgroundColor: palette.warmSoft, borderColor: palette.warmSoft, minHeight: 150 }}>
            <Icon name="map-outline" size={26} color={palette.warm} />
            <AppText variant="heading" serif style={{ marginTop: space.md }}>
              Learning path
            </AppText>
            <AppText variant="caption" muted style={{ marginTop: 4 }}>
              Sequence a handful of reads around a goal.
            </AppText>
          </Card>
        </Pressable>
      </View>

      <Card onPress={() => router.push('/browse')} style={{ paddingVertical: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name="add-circle-outline" size={20} color={palette.accent} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodySm" style={{ fontWeight: '600' }}>
              Add from the public catalogue
            </AppText>
            <AppText variant="caption" faint>
              Free classics you can download and read offline.
            </AppText>
          </View>
          <Icon name="chevron-forward" size={16} color={palette.inkFaint} />
        </View>
      </Card>

      {state.data?.jobs.length ? (
        <View style={{ gap: space.sm }}>
          <SectionHeader title="Processing" />
          {state.data.jobs.map((job) => (
            <Card key={job.id} style={{ paddingVertical: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <Icon
                  name={job.status === 'failed' ? 'alert-circle-outline' : 'sync-outline'}
                  size={18}
                  color={job.status === 'failed' ? palette.danger : palette.accent}
                />
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySm" style={{ textTransform: 'capitalize' }}>
                    {job.type.replace(/_/g, ' ')}
                  </AppText>
                  {job.error ? (
                    <AppText variant="caption" color={palette.danger} numberOfLines={2}>
                      {job.error}
                    </AppText>
                  ) : (
                    <AppText variant="caption" faint>
                      {job.status}
                    </AppText>
                  )}
                </View>
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      <SectionHeader title="From your library" style={{ marginTop: space.md }} />
      {state.loading ? <LoadingBlock /> : null}
      {state.data?.withDocs.length === 0 ? (
        <EmptyState
          icon="library-outline"
          title="No books yet"
          body="Add a free classic or import your own file, then you can summarise, narrate and practise it."
          actionLabel="Browse catalogue"
          onAction={() => router.push('/browse')}
        />
      ) : null}

      <View style={{ gap: space.sm }}>
        {state.data?.withDocs.map(({ book, document }) => (
          <Card key={book.id} onPress={() => router.push({ pathname: '/book/[id]', params: { id: book.id } })}>
            <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
              <Cover uri={book.coverUrl} title={book.title} width={44} height={64} />
              <View style={{ flex: 1, gap: 2 }}>
                <AppText variant="bodySm" numberOfLines={1} style={{ fontWeight: '600' }}>
                  {book.title}
                </AppText>
                <AppText variant="caption" faint numberOfLines={1}>
                  {document ? `${document.format.toUpperCase()} · ${document.wordCount ?? 0} words` : 'Metadata only'}
                </AppText>
              </View>
              <View style={{ flexDirection: 'row', gap: 2 }}>
                <Pressable
                  onPress={() => router.push({ pathname: '/read/[id]', params: { id: book.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={`Read ${book.title}`}
                  hitSlop={8}
                  style={{ padding: 8 }}
                >
                  <Icon name="book-outline" size={18} color={palette.inkMuted} />
                </Pressable>
                <Pressable
                  onPress={() => router.push({ pathname: '/listen/[id]', params: { id: book.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={`Listen to ${book.title}`}
                  hitSlop={8}
                  style={{ padding: 8 }}
                >
                  <Icon name="headset-outline" size={18} color={palette.inkMuted} />
                </Pressable>
                <Pressable
                  onPress={() => router.push({ pathname: '/chat/[id]', params: { id: book.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={`Ask about ${book.title}`}
                  hitSlop={8}
                  style={{ padding: 8 }}
                >
                  <Icon name="chatbubble-outline" size={18} color={palette.inkMuted} />
                </Pressable>
              </View>
            </View>
          </Card>
        ))}
      </View>

      <Sheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title="Build a learning path">
        <AppText variant="bodySm" muted>
          Pick a starting point. Freehaven searches the public catalogue for short, readable books and orders them.
        </AppText>
        <Field
          label="Or describe your goal"
          value={goal}
          onChangeText={setGoal}
          placeholder="e.g. understand how habits form"
          multiline={false}
        />
        <Button
          label="Build from this goal"
          onPress={() => goal.trim() && void buildPlan(goal.trim(), goal.trim())}
          loading={building}
          full
          disabled={!goal.trim()}
        />
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          {GOAL_TEMPLATES.map((template) => (
            <Card
              key={template.title}
              onPress={() => void buildPlan(template.title, template.goal, template.subject)}
              style={{ paddingVertical: space.md }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <View style={{ width: 34, height: 34, borderRadius: radius.sm, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="sparkles-outline" size={16} color={palette.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                    {template.title}
                  </AppText>
                  <AppText variant="caption" faint>
                    {template.subject}
                  </AppText>
                </View>
                <Icon name="arrow-forward" size={16} color={palette.inkFaint} />
              </View>
            </Card>
          ))}
        </View>
        {buildError ? (
          <AppText variant="caption" color={palette.danger}>
            {buildError}
          </AppText>
        ) : null}
        {building ? <LoadingBlock label="Building your path…" /> : null}
      </Sheet>
    </Screen>
  );
}
