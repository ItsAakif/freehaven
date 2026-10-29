import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  AppText,
  Card,
  Cover,
  Button,
  Header,
  ProgressBar,
  Sheet,
  LoadingBlock,
  EmptyState,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { addPlanItem, getPlan, listPlanItems, setPlanItemStatus } from '@/data/repositories/learning';
import { rebuildPlanSequence, sequenceSummary } from '@/data/repositories/mastery';
import { getProfile } from '@/data/repositories/profile';
import { listLibrary } from '@/data/repositories/books';

const NEXT_STATUS: Record<string, 'todo' | 'doing' | 'done'> = { todo: 'doing', doing: 'done', done: 'todo' };

export default function PlanScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const [tick, setTick] = useState(0);
  const [addOpen, setAddOpen] = useState(false);

  const state = useAsync(async () => {
    const plan = await getPlan(id);
    if (!plan) return { plan: null } as const;
    const [items, library, profile] = await Promise.all([listPlanItems(plan.id), listLibrary(), getProfile()]);
    return { plan, items, library, profile } as const;
  }, [id, tick]);

  if (state.loading) {
    return (
      <Screen>
        <Header title="Learning path" onBack={() => router.back()} />
        <LoadingBlock />
      </Screen>
    );
  }

  if (!state.data?.plan) {
    return (
      <Screen>
        <Header title="Learning path" onBack={() => router.back()} />
        <EmptyState icon="map-outline" title="Path not found" body="It may have been deleted." />
      </Screen>
    );
  }

  const { plan, items, library, profile } = state.data;
  const done = items.filter((i) => i.status === 'done').length;
  const pct = items.length ? done / items.length : 0;
  const missing = library.filter((book) => !items.some((item) => item.bookId === book.id));

  return (
    <Screen>
      <Header title={plan.title} subtitle={plan.goal ?? undefined} onBack={() => router.back()} />

      <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.accentSoft }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.sm }}>
          <AppText variant="caption" muted>
            {done}/{items.length} complete
          </AppText>
          <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
            {Math.round(pct * 100)}%
          </AppText>
        </View>
        <ProgressBar value={pct} />
        <AppText variant="caption" faint style={{ marginTop: space.sm }}>
          {sequenceSummary(profile)}
        </AppText>
        <View style={{ marginTop: space.md }}>
          <Button
            label="Re-optimise order"
            icon="shuffle-outline"
            variant="secondary"
            size="sm"
            onPress={() =>
              void (async () => {
                await rebuildPlanSequence(plan.id, profile);
                setTick((t) => t + 1);
              })()
            }
          />
        </View>
      </Card>

      {items.map((item, i) => (
        <Card key={item.id} style={{ paddingVertical: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Pressable
              onPress={() =>
                void (async () => {
                  await setPlanItemStatus(item.id, NEXT_STATUS[item.status]);
                  setTick((t) => t + 1);
                })()
              }
              accessibilityRole="button"
              accessibilityLabel={`Mark ${item.title} as ${NEXT_STATUS[item.status]}`}
              hitSlop={8}
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                borderWidth: 1.5,
                borderColor: item.status === 'done' ? palette.accent : palette.lineStrong,
                backgroundColor: item.status === 'done' ? palette.accent : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {item.status === 'done' ? <Ionicons name="checkmark" size={16} color={palette.accentInk} /> : null}
              {item.status === 'doing' ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette.warm }} /> : null}
            </Pressable>
            <Cover uri={item.coverUrl} title={item.title} width={40} height={58} />
            <Pressable
              style={{ flex: 1 }}
              onPress={() => router.push({ pathname: '/book/[id]', params: { id: item.bookId } })}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.title}`}
            >
              <AppText variant="bodySm" numberOfLines={2} style={{ fontWeight: '600', textDecorationLine: item.status === 'done' ? 'line-through' : 'none' }}>
                {i + 1}. {item.title}
              </AppText>
              <AppText variant="caption" faint>
                {item.status}
              </AppText>
              {item.reason ? (
                <AppText variant="caption" color={palette.accent} numberOfLines={2}>
                  {item.reason}
                </AppText>
              ) : null}
            </Pressable>
            <Ionicons name="chevron-forward" size={16} color={palette.inkFaint} />
          </View>
        </Card>
      ))}

      {items.length === 0 ? (
        <EmptyState icon="library-outline" title="This path is empty" body="Add books from your library to build the sequence." />
      ) : null}

      <Button label="Add from library" icon="add" variant="secondary" onPress={() => setAddOpen(true)} full />

      <Sheet visible={addOpen} onClose={() => setAddOpen(false)} title="Add a book">
        {missing.length === 0 ? (
          <AppText variant="caption" faint>
            Every book in your library is already on this path.
          </AppText>
        ) : null}
        {missing.map((book) => (
          <Pressable
            key={book.id}
            onPress={() =>
              void (async () => {
                await addPlanItem(plan.id, book.id, items.length);
                setTick((t) => t + 1);
                setAddOpen(false);
              })()
            }
            accessibilityRole="button"
            accessibilityLabel={`Add ${book.title}`}
            style={{ paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: palette.line }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <Cover uri={book.coverUrl} title={book.title} width={36} height={52} />
              <AppText variant="bodySm" style={{ flex: 1 }} numberOfLines={2}>
                {book.title}
              </AppText>
              <Ionicons name="add" size={18} color={palette.accent} />
            </View>
          </Pressable>
        ))}
      </Sheet>
    </Screen>
  );
}
