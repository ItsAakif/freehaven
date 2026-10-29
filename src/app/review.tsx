import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import {
  Screen,
  AppText,
  Card,
  Button,
  Header,
  ProgressBar,
  Field,
  Sheet,
  EmptyState,
  LoadingBlock,
} from '@/design/ui';
import { radius, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { dueCards, deleteCard, getCard, reviewCard, updateCard } from '@/data/repositories/learning';
import { getChunk } from '@/data/repositories/reading';
import { GRADE_LABELS, schedule } from '@/domain/fsrs';
import type { Card as CardModel, Grade } from '@/domain/types';

export default function ReviewScreen() {
  const { palette } = useTheme();
  const [queue, setQueue] = useState<CardModel[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<Grade, number>>({ 1: 0, 2: 0, 3: 0, 4: 0 });
  const [quote, setQuote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const cards = await dueCards(Date.now(), 40);
    setQueue(cards);
    setIndex(0);
    setRevealed(false);
    setSelected(null);
    setCounts({ 1: 0, 2: 0, 3: 0, 4: 0 });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const card = queue[index];

  useEffect(() => {
    let active = true;
    setQuote(null);
    if (card?.sourceChunkId) {
      getChunk(card.sourceChunkId)
        .then((chunk) => {
          if (active && chunk) setQuote(chunk.text.slice(0, 320));
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [card?.id, card?.sourceChunkId]);

  const grade = async (rating: Grade) => {
    if (!card) return;
    await reviewCard(card.id, rating);
    setCounts((c) => ({ ...c, [rating]: c[rating] + 1 }));
    setRevealed(false);
    setSelected(null);
    if (index + 1 >= queue.length) {
      setIndex(index + 1);
    } else {
      setIndex(index + 1);
    }
  };

  const startEdit = () => {
    if (!card) return;
    setFront(card.front);
    setBack(card.back);
    setEditing(true);
  };

  if (loading) {
    return (
      <Screen>
        <Header title="Review" onBack={() => router.back()} />
        <LoadingBlock label="Building your queue…" />
      </Screen>
    );
  }

  if (!queue.length) {
    return (
      <Screen>
        <Header title="Review" onBack={() => router.back()} />
        <EmptyState
          icon="checkmark-done-outline"
          title="Nothing due right now"
          body="New cards appear here when they are scheduled. Make cards from a book to get started."
          actionLabel="Go to Today"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  if (index >= queue.length) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return (
      <Screen>
        <Header title="Review" onBack={() => router.back()} />
        <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, alignItems: 'center', paddingVertical: space.xxxl }}>
          <AppText variant="display" serif>
            {total}
          </AppText>
          <AppText variant="bodySm" muted>
            cards reviewed
          </AppText>
          <View style={{ flexDirection: 'row', gap: space.lg, marginTop: space.lg }}>
            {([1, 2, 3, 4] as Grade[]).map((g) => (
              <View key={g} style={{ alignItems: 'center' }}>
                <AppText variant="heading" serif>
                  {counts[g]}
                </AppText>
                <AppText variant="caption" faint>
                  {GRADE_LABELS[g]}
                </AppText>
              </View>
            ))}
          </View>
        </Card>
        <Button label="Back to Today" onPress={() => router.back()} full />
        <Button label="Check for more" variant="secondary" onPress={() => void load()} full />
      </Screen>
    );
  }

  const preview = ([1, 2, 3, 4] as Grade[]).map((g) => ({ grade: g, days: schedule(card, g).scheduledDays }));
  const isMcq = card.kind === 'mcq' && !!card.options?.length;

  return (
    <Screen>
      <Header
        title="Review"
        subtitle={`${index + 1} of ${queue.length}`}
        onBack={() => router.back()}
        right={<Button label="Edit" variant="ghost" size="sm" onPress={startEdit} />}
      />

      <ProgressBar value={(index + 1) / queue.length} />

      <Card style={{ minHeight: 220, justifyContent: 'center', gap: space.md }}>
        <AppText variant="subheading" serif>
          {card.front}
        </AppText>

        {isMcq ? (
          <View style={{ gap: space.sm }}>
            {card.options!.map((option) => {
              const chosen = selected === option;
              const correct = option === card.answer;
              const showState = !!selected;
              return (
                <Pressable
                  key={option}
                  onPress={() => {
                    if (selected) return;
                    setSelected(option);
                    setRevealed(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={option}
                  style={{
                    padding: space.md,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: showState && correct ? palette.accent : showState && chosen ? palette.danger : palette.line,
                    backgroundColor: showState && correct ? palette.accentSoft : palette.surfaceAlt,
                  }}
                >
                  <AppText variant="bodySm">{option}</AppText>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {card.back && revealed ? (
          <View style={{ gap: 6, marginTop: space.sm }}>
            <AppText variant="caption" faint>
              Answer
            </AppText>
            <AppText variant="body" serif>
              {card.back}
            </AppText>
          </View>
        ) : null}
      </Card>

      {!revealed ? (
        <Button label="Show answer" onPress={() => setRevealed(true)} full />
      ) : (
        <View style={{ gap: space.sm }}>
          {card.explanation ? (
            <AppText variant="caption" muted>
              {card.explanation}
            </AppText>
          ) : null}
          {quote ? (
            <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
              <AppText variant="caption" serif numberOfLines={4}>
                “{quote}”
              </AppText>
            </Card>
          ) : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {preview.map(({ grade: g, days }) => (
              <Pressable
                key={g}
                onPress={() => void grade(g)}
                accessibilityRole="button"
                accessibilityLabel={`${GRADE_LABELS[g]}, next review in ${days} days`}
                style={{
                  flex: 1,
                  paddingVertical: space.md,
                  borderRadius: radius.md,
                  backgroundColor:
                    g === 1 ? palette.dangerSoft : g === 4 ? palette.accent : palette.surfaceAlt,
                  alignItems: 'center',
                  gap: 2,
                }}
              >
                <AppText
                  variant="label"
                  color={g === 4 ? palette.accentInk : g === 1 ? palette.danger : palette.ink}
                  style={{ fontWeight: '700' }}
                >
                  {GRADE_LABELS[g]}
                </AppText>
                <AppText
                  variant="caption"
                  color={g === 4 ? palette.accentInk : palette.inkMuted}
                  style={{ opacity: g === 4 ? 0.8 : 1 }}
                >
                  {days}d
                </AppText>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <Sheet visible={editing} onClose={() => setEditing(false)} title="Edit card">
        <Field label="Front" value={front} onChangeText={setFront} multiline />
        <Field label="Back" value={back} onChangeText={setBack} multiline />
        <Button
          label="Save"
          full
          loading={saving}
          onPress={() =>
            void (async () => {
              if (!card) return;
              setSaving(true);
              await updateCard(card.id, { front, back });
              const updated = await getCard(card.id);
              if (updated) setQueue((q) => q.map((c) => (c.id === updated.id ? updated : c)));
              setSaving(false);
              setEditing(false);
            })()
          }
        />
        <Button
          label="Delete card"
          variant="danger"
          full
          onPress={() =>
            void (async () => {
              if (!card) return;
              await deleteCard(card.id);
              setQueue((q) => q.filter((c) => c.id !== card.id));
              setEditing(false);
            })()
          }
        />
      </Sheet>
    </Screen>
  );
}
