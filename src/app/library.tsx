import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Directory, Paths } from 'expo-file-system';
import {
  Screen,
  AppText,
  Card,
  Cover,
  ProgressBar,
  EmptyState,
  SectionHeader,
  IconButton,
  Button,
  Header,
  LoadingBlock,
  ErrorState,
  Sheet,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { useDatabase } from '@/data/DatabaseProvider';
import { countLibrary } from '@/data/repositories/books';
import { listLibraryEntries, deleteRendition } from '@/data/repositories/renditions';
import { segmentDir } from '@/features/data/paths';
import { getNarrationStyle } from '@/features/narration/styles';
import type { LibraryEntry, LibraryShelf } from '@/domain/types';

type LibraryData = {
  total: number;
  inProgress: LibraryEntry[];
  downloaded: LibraryEntry[];
  completed: LibraryEntry[];
};

const SHELVES: { id: LibraryShelf; title: string; empty: string }[] = [
  { id: 'in_progress', title: 'In progress', empty: 'Nothing in progress yet.' },
  { id: 'downloaded', title: 'Downloaded', empty: 'No downloaded narration yet.' },
  { id: 'completed', title: 'Completed', empty: 'Nothing finished yet.' },
];

function entryMeta(entry: LibraryEntry): string {
  if (entry.rendition) {
    const style = getNarrationStyle(entry.rendition.styleId);
    return `${style.label} · ${entry.rendition.length} min · ${Math.round(entry.percent * 100)}% narrated`;
  }
  return `${Math.round(entry.percent * 100)}% read`;
}

function actionLabel(shelf: LibraryShelf, entry: LibraryEntry): string {
  if (shelf === 'completed') return 'Open';
  if (shelf === 'downloaded') return 'Listen';
  return entry.rendition ? 'Resume' : 'Read';
}

function openEntry(shelf: LibraryShelf, entry: LibraryEntry) {
  if (shelf === 'in_progress') {
    if (entry.rendition) {
      router.push({
        pathname: '/listen/[id]',
        params: { id: entry.book.id, rendition: entry.rendition.id, t: String(entry.positionMs) },
      });
    } else {
      router.push({ pathname: '/read/[id]', params: { id: entry.book.id } });
    }
    return;
  }
  if (shelf === 'downloaded') {
    router.push({
      pathname: '/listen/[id]',
      params: {
        id: entry.book.id,
        t: '0',
        ...(entry.rendition ? { rendition: entry.rendition.id } : {}),
      },
    });
    return;
  }
  router.push({ pathname: '/book/[id]', params: { id: entry.book.id } });
}

function LibraryRow({
  shelf,
  entry,
  onDelete,
}: {
  shelf: LibraryShelf;
  entry: LibraryEntry;
  onDelete?: (entry: LibraryEntry) => void;
}) {
  const { palette } = useTheme();
  const open = () => openEntry(shelf, entry);
  return (
    <Card onPress={open} accessibilityLabel={`${entry.book.title} by ${entry.book.author ?? 'unknown'}`}>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <Cover uri={entry.book.coverUrl} title={entry.book.title} width={56} height={82} />
        <View style={{ flex: 1, gap: 4 }}>
          <AppText variant="subheading" serif numberOfLines={2}>
            {entry.book.title}
          </AppText>
          <AppText variant="caption" muted numberOfLines={1}>
            {entry.book.author ?? 'Unknown author'}
          </AppText>
          <AppText variant="caption" faint numberOfLines={1}>
            {entryMeta(entry)}
          </AppText>
          <ProgressBar value={entry.percent} style={{ marginTop: space.xs }} />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.xs, flexWrap: 'wrap' }}>
            {shelf === 'downloaded' ? (
              <>
                <Button
                  label="Re-make"
                  size="sm"
                  variant="ghost"
                  onPress={() => router.push({ pathname: '/book/[id]', params: { id: entry.book.id } })}
                />
                {onDelete ? (
                  <Button label="Delete download" size="sm" variant="danger" onPress={() => onDelete(entry)} />
                ) : null}
              </>
            ) : null}
            <Button label={actionLabel(shelf, entry)} size="sm" variant="secondary" onPress={open} />
          </View>
        </View>
      </View>
      {entry.downloaded ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.sm }}>
          <AppText variant="caption" color={palette.accent} style={{ fontWeight: '600' }}>
            Downloaded
          </AppText>
        </View>
      ) : null}
    </Card>
  );
}

export default function LibraryScreen() {
  useDatabase();
  const [tick, setTick] = useState(0);
  const [confirmEntry, setConfirmEntry] = useState<LibraryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setTick((t) => t + 1);
    }, []),
  );

  const state = useAsync<LibraryData>(async () => {
    const [total, inProgress, downloaded, completed] = await Promise.all([
      countLibrary(),
      listLibraryEntries('in_progress'),
      listLibraryEntries('downloaded'),
      listLibraryEntries('completed'),
    ]);
    return { total, inProgress, downloaded, completed };
  }, [tick]);

  const data = state.data;
  const byShelf: Record<LibraryShelf, LibraryEntry[]> = {
    in_progress: data?.inProgress ?? [],
    downloaded: data?.downloaded ?? [],
    completed: data?.completed ?? [],
  };
  const hasAnyShelf = SHELVES.some((shelf) => byShelf[shelf.id].length > 0);

  const removeDownload = async () => {
    const rendition = confirmEntry?.rendition;
    if (!rendition) return;
    setDeleting(true);
    try {
      await deleteRendition(rendition.id);
      try {
        const dir = new Directory(Paths.document, segmentDir(rendition.id));
        if (dir.exists) dir.delete();
      } catch {
        /* the row is gone; leftover files can be cleared with the cache */
      }
      setConfirmEntry(null);
      state.reload();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Screen>
      <Header
        title="Library"
        onBack={() => router.back()}
        right={<IconButton name="search-outline" label="Browse the catalogue" onPress={() => router.push('/browse')} />}
      />

      {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}

      {state.loading && !data ? <LoadingBlock label="Opening your library" /> : null}

      {data && data.total === 0 ? (
        <View style={{ gap: space.md }}>
          <EmptyState
            icon="library-outline"
            title="Your library is empty"
            body="Save a public-domain classic, or bring a file of your own. Everything stays on this device."
          />
          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
            <Button label="Browse classics" icon="library-outline" onPress={() => router.push('/browse')} />
            <Button label="Import a file" icon="cloud-upload-outline" variant="secondary" onPress={() => router.push('/import')} />
          </View>
        </View>
      ) : null}

      {data && data.total > 0 && !hasAnyShelf ? (
        <EmptyState
          icon="headset-outline"
          title="No progress yet"
          body="Open a book to start reading, or make a narration from its detail page."
          actionLabel="Browse classics"
          onAction={() => router.push('/browse')}
        />
      ) : null}

      {data && data.total > 0
        ? SHELVES.map((shelf) => {
            const entries = byShelf[shelf.id];
            if (!entries.length) {
              return hasAnyShelf ? (
                <AppText key={`empty:${shelf.id}`} variant="caption" faint>
                  {shelf.empty}
                </AppText>
              ) : null;
            }
            return (
              <View key={shelf.id} style={{ gap: space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
                  <SectionHeader title={shelf.title} style={{ flex: 1 }} />
                  <AppText variant="caption" faint>
                    {entries.length}
                  </AppText>
                </View>
                {entries.map((entry) => (
                  <LibraryRow
                    key={`${shelf.id}:${entry.book.id}:${entry.rendition?.id ?? 'read'}`}
                    shelf={shelf.id}
                    entry={entry}
                    onDelete={shelf.id === 'downloaded' ? setConfirmEntry : undefined}
                  />
                ))}
              </View>
            );
          })
        : null}

      <Sheet visible={!!confirmEntry} onClose={() => setConfirmEntry(null)} title="Delete this download?">
        <AppText variant="bodySm" muted>
          {confirmEntry
            ? `The generated audio for “${confirmEntry.book.title}” will be removed from this device. The book and its reading progress stay.`
            : ''}
        </AppText>
        <Button
          label="Delete download"
          variant="danger"
          full
          loading={deleting}
          onPress={() => void removeDownload()}
        />
        <Button label="Cancel" variant="ghost" full onPress={() => setConfirmEntry(null)} />
      </Sheet>
    </Screen>
  );
}
