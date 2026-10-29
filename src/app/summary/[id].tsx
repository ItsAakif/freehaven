import React, { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Speech from 'expo-speech';
import {
  Screen,
  AppText,
  Card,
  Button,
  Header,
  Chip,
  Field,
  LoadingBlock,
  EmptyState,
  Divider,
  Sheet,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { deleteSummary, getSummary, summarySourceChunks, updateSummaryBody } from '@/data/repositories/learning';
import { getBook } from '@/data/repositories/books';
import { getChunk } from '@/data/repositories/reading';
import { generateCardsForBook } from '@/features/learning/generate';
import { Markdown } from '@/design/markdown';
import type { Chunk } from '@/domain/types';

export default function SummaryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [citationsOpen, setCitationsOpen] = useState(false);
  const [tick, setTick] = useState(0);

  const state = useAsync(async () => {
    const summary = await getSummary(id);
    if (!summary) return { summary: null } as const;
    const [book, chunkIds] = await Promise.all([getBook(summary.bookId), summarySourceChunks(summary.id)]);
    const chunks: Chunk[] = [];
    for (const chunkId of chunkIds.slice(0, 20)) {
      const chunk = await getChunk(chunkId);
      if (chunk) chunks.push(chunk);
    }
    return { summary, book, chunks } as const;
  }, [id, tick]);

  if (state.loading) {
    return (
      <Screen>
        <Header title="Lesson" onBack={() => router.back()} />
        <LoadingBlock />
      </Screen>
    );
  }

  if (!state.data?.summary) {
    return (
      <Screen>
        <Header title="Lesson" onBack={() => router.back()} />
        <EmptyState icon="reader-outline" title="This lesson is gone" body="It may have been deleted." />
      </Screen>
    );
  }

  const { summary, book, chunks } = state.data;

  const run = async (label: string, fn: () => Promise<void>) => {
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

  return (
    <Screen>
      <Header
        title={summary.title}
        subtitle={book?.title}
        onBack={() => router.back()}
        right={
          <Button
            label={editing ? 'Done' : 'Edit'}
            variant="ghost"
            size="sm"
            onPress={() => {
              if (editing) {
                void run('save', async () => {
                  await updateSummaryBody(summary.id, draft);
                  setTick((t) => t + 1);
                  setEditing(false);
                });
              } else {
                setDraft(summary.bodyMd);
                setEditing(true);
              }
            }}
          />
        }
      />

      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Chip label={summary.provider === 'extractive' ? 'On-device' : 'Remote model'} icon={summary.provider === 'extractive' ? 'phone-portrait-outline' : 'cloud-outline'} active />
        <Chip label={summary.kind} />
        {summary.model ? <Chip label={summary.model} /> : null}
        {chunks.length ? (
          <Chip label={`${chunks.length} sources`} icon="link-outline" onPress={() => setCitationsOpen(true)} />
        ) : null}
      </View>

      {error ? (
        <Card style={{ backgroundColor: palette.dangerSoft, borderColor: palette.dangerSoft }}>
          <AppText variant="caption" color={palette.danger}>
            {error}
          </AppText>
        </Card>
      ) : null}

      {editing ? (
        <>
          <Field value={draft} onChangeText={setDraft} multiline style={{ minHeight: 300 }} label="Lesson text (Markdown)" />
          <Button
            label="Save changes"
            onPress={() =>
              void run('save', async () => {
                await updateSummaryBody(summary.id, draft);
                setTick((t) => t + 1);
                setEditing(false);
              })
            }
            loading={busy === 'save'}
            full
          />
        </>
      ) : (
        <View style={{ gap: space.md }}>
          <Markdown content={summary.bodyMd} />
        </View>
      )}

      <Divider />

      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button
          label="Listen"
          icon="play"
          variant="secondary"
          size="sm"
          onPress={() => {
            void Speech.stop();
            Speech.speak(summary.bodyMd.replace(/[#*_`>-]/g, ' '), { rate: 1 });
          }}
        />
        <Button
          label="Build cards"
          icon="albums-outline"
          variant="secondary"
          size="sm"
          loading={busy === 'cards'}
          onPress={() =>
            void run('cards', async () => {
              await generateCardsForBook(summary.bookId, 10);
              router.push('/review');
            })
          }
        />
        <Button label="Open book" icon="book-outline" variant="secondary" size="sm" onPress={() => router.push({ pathname: '/book/[id]', params: { id: summary.bookId } })} />
        <Button
          label="Delete"
          icon="trash-outline"
          variant="danger"
          size="sm"
          onPress={() =>
            void run('delete', async () => {
              await deleteSummary(summary.id);
              router.back();
            })
          }
        />
      </View>

      <AppText variant="caption" faint>
        Generated {new Date(summary.createdAt).toLocaleString()} · {summary.provider === 'extractive' ? 'extracted on device' : 'generated by a model'}. Always verify against the source.
      </AppText>

      <Sheet visible={citationsOpen} onClose={() => setCitationsOpen(false)} title="Sources">
        {chunks.map((chunk) => (
          <Card key={chunk.id} style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
            <AppText variant="caption" serif numberOfLines={6}>
              {chunk.text}
            </AppText>
            <AppText variant="caption" faint style={{ marginTop: 6 }}>
              {chunk.page ? `Page ${chunk.page}` : 'Indexed passage'}
            </AppText>
          </Card>
        ))}
        {chunks.length === 0 ? <AppText variant="caption" faint>No source links were recorded for this lesson.</AppText> : null}
      </Sheet>
    </Screen>
  );
}
