import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/design/icon';
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
import { completeGuideChapter, guideStats, uncompleteGuideChapter } from '@/data/repositories/guides';
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
    const guideId =
      items.length > 0 && items.every((item) => item.guideChapterId) ? items[0].guideId : null;
    const guide = guideId ? await guideStats(guideId) : null;
    return { plan, items, library, profile, guide } as const;
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

  const { plan, items, library, profile, guide } = state.data;
  const done = items.filter((i) => i.status === 'done').length;
  const pct = items.length ? done / items.length : 0;
  const missing = library.filter((book) => !items.some((item) => item.bookId === book.id));
  const isGuidePlan = items.length > 0 && items.every((item) => item.guideChapterId);
  const guideId = isGuidePlan ? items[0]?.guideId ?? null : null;

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
          {isGuidePlan
            ? guide && guide.streakDays > 0
              ? `${guide.streakDays}-day guide streak · one chapter a day`
              : 'One chapter a day.'
            : sequenceSummary(profile)}
        </AppText>
        <View style={{ marginTop: space.md }}>
          {isGuidePlan ? (
            <Button
              label="Open full guide"
              icon="reader-outline"
              variant="secondary"
              size="sm"
              onPress={() => {
                if (guideId) {
                  router.push({ pathname: '/full-guide/[guideId]', params: { guideId } });
                }
              }}
            />
          ) : (
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
          )}
        </View>
      </Card>

      {items.map((item, i) => {
        if (isGuidePlan) {
          const completed = item.status === 'done';
          const ready = item.guideChapterStatus === 'ready';
          return (
            <Card key={item.id} style={{ paddingVertical: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <Pressable
                  onPress={() =>
                    void (async () => {
                      if (!item.guideChapterId) return;
                      if (completed) await uncompleteGuideChapter(item.guideChapterId);
                      else await completeGuideChapter(item.guideChapterId);
                      setTick((t) => t + 1);
                    })()
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${
                    item.guideChapterTitle ?? `chapter ${i + 1}`
                  } as ${completed ? 'not done' : 'done'}`}
                  hitSlop={8}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    borderWidth: 1.5,
                    borderColor: completed ? palette.accent : palette.lineStrong,
                    backgroundColor: completed ? palette.accent : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {completed ? <Icon name="checkmark" size={16} color={palette.accentInk} /> : null}
                </Pressable>
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: palette.surfaceAlt,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
                    {i + 1}
                  </AppText>
                </View>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => {
                    if (ready && item.guideChapterId) {
                      router.push({
                        pathname: '/listen/[id]',
                        params: { id: item.bookId, guideChapter: item.guideChapterId },
                      });
                    } else if (item.guideId) {
                      router.push({
                        pathname: '/full-guide/[guideId]',
                        params: { guideId: item.guideId },
                      });
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${
                    item.guideChapterTitle ?? `chapter ${i + 1}`
                  }`}
                >
                  <AppText
                    variant="bodySm"
                    numberOfLines={2}
                    style={{
                      fontWeight: '600',
                      textDecorationLine: completed ? 'line-through' : 'none',
                    }}
                  >
                    {item.guideChapterTitle ?? item.title}
                  </AppText>
                  <AppText variant="caption" faint numberOfLines={1}>
                    Chapter {i + 1} of {items.length} · {item.guideTitle ?? 'Full guide'}
                  </AppText>
                  <AppText variant="caption" color={ready ? palette.accent : palette.inkMuted}>
                    {ready
                      ? completed
                        ? 'Ready · done'
                        : 'Ready'
                      : item.guideChapterStatus ?? 'pending'}
                  </AppText>
                </Pressable>
                <Icon name="chevron-forward" size={16} color={palette.inkFaint} />
              </View>
            </Card>
          );
        }

        return (
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
                {item.status === 'done' ? <Icon name="checkmark" size={16} color={palette.accentInk} /> : null}
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
              <Icon name="chevron-forward" size={16} color={palette.inkFaint} />
            </View>
          </Card>
        );
      })}

      {items.length === 0 ? (
        <EmptyState icon="library-outline" title="This path is empty" body="Add books from your library to build the sequence." />
      ) : null}

      {!isGuidePlan ? (
        <Button label="Add from library" icon="add" variant="secondary" onPress={() => setAddOpen(true)} full />
      ) : null}

      {!isGuidePlan ? (
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
                <Icon name="add" size={18} color={palette.accent} />
              </View>
            </Pressable>
          ))}
        </Sheet>
      ) : null}
    </Screen>
  );
}
