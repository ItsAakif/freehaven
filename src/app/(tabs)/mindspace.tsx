import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  AppText,
  Card,
  Chip,
  Field,
  EmptyState,
  Reveal,
  Stat,
  Divider,
  ProgressBar,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { listHighlightsWithBooks, listBookmarksWithBooks, listBookmarkFolders } from '@/data/repositories/reading';
import { listConversations } from '@/data/repositories/mindspace';
import { listRecentSummaries, reviewStats } from '@/data/repositories/learning';
import { listActivity } from '@/data/repositories/activity';
import { topicMastery } from '@/data/repositories/mastery';
import { formatRelative } from '@/lib/id';

type Filter = 'all' | 'highlights' | 'notes' | 'bookmarks' | 'chats' | 'lessons' | 'activity';

const ACTIVITY_LABEL: Record<string, string> = {
  read: 'Read',
  listen: 'Listened',
  review: 'Reviewed a card',
  highlight: 'Saved a highlight',
  lesson: 'Generated a lesson',
  chat: 'Asked the book',
  import: 'Imported a document',
  bookmark: 'Added a bookmark',
  plan: 'Re-ordered a learning path',
};

const ACTIVITY_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  read: 'book-outline',
  listen: 'headset-outline',
  review: 'albums-outline',
  highlight: 'color-wand-outline',
  lesson: 'reader-outline',
  chat: 'chatbubbles-outline',
  import: 'cloud-upload-outline',
  bookmark: 'bookmark-outline',
  plan: 'map-outline',
};

export default function MindspaceScreen() {
  const { palette } = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useFocusEffect(
    useCallback(() => {
      setTick((t) => t + 1);
    }, []),
  );

  const state = useAsync(async () => {
    const [highlights, conversations, summaries, stats, bookmarks, folders, activity, mastery] = await Promise.all([
      listHighlightsWithBooks(),
      listConversations(),
      listRecentSummaries(20),
      reviewStats(),
      listBookmarksWithBooks(),
      listBookmarkFolders(),
      listActivity(30),
      topicMastery(),
    ]);
    return { highlights, conversations, summaries, stats, bookmarks, folders, activity, mastery };
  }, [tick]);

  const notes = useMemo(
    () => (state.data?.highlights ?? []).filter((h) => (h.note ?? '').trim().length > 0),
    [state.data],
  );

  const term = search.trim().toLowerCase();
  const match = (text: string) => !term || text.toLowerCase().includes(term);

  const filteredHighlights = (state.data?.highlights ?? []).filter(
    (h) => match(h.quote) || match(h.note ?? '') || match(h.bookTitle),
  );
  const filteredNotes = notes.filter((h) => match(h.note ?? '') || match(h.bookTitle));
  const filteredChats = (state.data?.conversations ?? []).filter(
    (c) => match(c.title) || match(c.lastMessage ?? ''),
  );
  const filteredBookmarks = (state.data?.bookmarks ?? []).filter(
    (b) =>
      (match(b.label ?? '') || match(b.bookTitle) || (b.tags ?? []).some(match)) &&
      (!folderFilter || b.folderId === folderFilter),
  );
  const filteredLessons = (state.data?.summaries ?? []).filter(
    (s) => match(s.title) || match(s.bookTitle),
  );

  const show = (section: Filter) => filter === 'all' || filter === section;

  return (
    <Screen>
      <View style={{ paddingTop: space.sm, gap: 4 }}>
        <AppText variant="caption" faint style={{ textTransform: 'uppercase', letterSpacing: 1.4 }}>
          Mindspace
        </AppText>
        <AppText variant="display" serif>
          What you’ve kept
        </AppText>
        <AppText variant="bodySm" muted>
          Highlights, notes and conversations, tied to the page they came from.
        </AppText>
      </View>

      <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat value={String(state.data?.stats.totalCards ?? 0)} label="cards" />
          <Stat value={String(state.data?.stats.streakDays ?? 0)} label="day streak" />
          <Stat value={String(state.data?.highlights.length ?? 0)} label="highlights" />
          <Stat value={String(state.data?.conversations.length ?? 0)} label="chats" />
        </View>
      </Card>

      {state.data?.mastery.length ? (
        <Card style={{ gap: space.sm }}>
          <AppText variant="label" muted>
            TOPIC MASTERY
          </AppText>
          {state.data.mastery.slice(0, 5).map((topic) => {
            const pct = topic.cards ? topic.mature / topic.cards : 0;
            return (
              <View key={topic.topic} style={{ gap: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <AppText variant="bodySm" style={{ textTransform: 'capitalize' }}>
                    {topic.topic}
                  </AppText>
                  <AppText variant="caption" faint>
                    {topic.mature}/{topic.cards} mature{topic.due ? ` · ${topic.due} due` : ''}
                  </AppText>
                </View>
                <ProgressBar value={pct} height={5} color={palette.accent} />
              </View>
            );
          })}
        </Card>
      ) : null}

      <Field
        value={search}
        onChangeText={setSearch}
        placeholder="Search your notes and highlights"
        autoCorrect={false}
        accessibilityLabel="Search notes and highlights"
      />

      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        {(['all', 'highlights', 'notes', 'bookmarks', 'chats', 'lessons', 'activity'] as Filter[]).map((f) => (
          <Chip key={f} label={f[0].toUpperCase() + f.slice(1)} active={filter === f} onPress={() => setFilter(f)} />
        ))}
      </View>

      {show('highlights') ? (
        <Reveal>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: space.sm }}>
            <AppText variant="heading" serif>
              Highlights
            </AppText>
            <AppText variant="caption" faint>
              {filteredHighlights.length}
            </AppText>
          </View>
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {filteredHighlights.slice(0, 12).map((highlight) => (
              <Card
                key={highlight.id}
                onPress={() => router.push({ pathname: '/read/[id]', params: { id: highlight.bookId, locator: highlight.locator } })}
              >
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <View style={{ width: 3, borderRadius: 2, backgroundColor: palette.gold }} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <AppText variant="bodySm" serif numberOfLines={4}>
                      “{highlight.quote}”
                    </AppText>
                    {highlight.note ? (
                      <AppText variant="caption" muted>
                        {highlight.note}
                      </AppText>
                    ) : null}
                    <AppText variant="caption" faint>
                      {highlight.bookTitle} · {formatRelative(highlight.createdAt)}
                    </AppText>
                  </View>
                </View>
              </Card>
            ))}
            {filteredHighlights.length === 0 ? (
              <EmptyState
                icon="bookmark-outline"
                title={term ? 'Nothing matches' : 'No highlights yet'}
                body={term ? 'Try a different word.' : 'Select text in the reader to keep a passage here.'}
              />
            ) : null}
          </View>
        </Reveal>
      ) : null}

      {show('bookmarks') ? (
        <View style={{ marginTop: space.lg }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <AppText variant="heading" serif>
              Bookmarks
            </AppText>
            <AppText variant="caption" faint>
              {filteredBookmarks.length}
            </AppText>
          </View>
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {state.data?.folders.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                <Chip label="All folders" active={!folderFilter} onPress={() => setFolderFilter(null)} />
                {state.data.folders.map((folder) => (
                  <Chip
                    key={folder.id}
                    label={folder.name}
                    active={folderFilter === folder.id}
                    onPress={() => setFolderFilter(folder.id)}
                  />
                ))}
              </View>
            ) : null}
            {filteredBookmarks.slice(0, 10).map((bookmark) => (
              <Card
                key={bookmark.id}
                onPress={() => router.push({ pathname: '/read/[id]', params: { id: bookmark.bookId, locator: bookmark.locator } })}
                style={{ paddingVertical: space.md }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Ionicons name="bookmark-outline" size={18} color={palette.gold} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySm" numberOfLines={1} style={{ fontWeight: '600' }}>
                      {bookmark.label ?? 'Bookmark'}
                    </AppText>
                    <AppText variant="caption" faint numberOfLines={1}>
                      {bookmark.bookTitle} · {formatRelative(bookmark.createdAt)}
                      {bookmark.folderName ? ` · ${bookmark.folderName}` : ''}
                    </AppText>
                    {bookmark.tags?.length ? (
                      <AppText variant="caption" color={palette.accent} numberOfLines={1}>
                        {bookmark.tags.map((t) => `#${t}`).join(' ')}
                      </AppText>
                    ) : null}
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={palette.inkFaint} />
                </View>
              </Card>
            ))}
            {filteredBookmarks.length === 0 ? (
              <EmptyState
                icon="bookmark-outline"
                title={term ? 'Nothing matches' : 'No bookmarks yet'}
                body={term ? 'Try a different word.' : 'Tap the bookmark icon in the reader to keep a place.'}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {show('notes') && filteredNotes.length ? (
        <View style={{ marginTop: space.lg }}>
          <AppText variant="heading" serif>
            Your notes
          </AppText>
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {filteredNotes.slice(0, 8).map((note) => (
              <Card key={note.id} style={{ backgroundColor: palette.warmSoft, borderColor: palette.warmSoft }}>
                <AppText variant="bodySm">{note.note}</AppText>
                <AppText variant="caption" faint style={{ marginTop: 6 }}>
                  on “{note.quote.slice(0, 60)}…” · {note.bookTitle}
                </AppText>
              </Card>
            ))}
          </View>
        </View>
      ) : null}

      {show('chats') ? (
        <View style={{ marginTop: space.lg }}>
          <AppText variant="heading" serif>
            Conversations
          </AppText>
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {filteredChats.map((conversation) => (
              <Card
                key={conversation.id}
                onPress={() => router.push({ pathname: '/chat/[id]', params: { id: conversation.id } })}
                style={{ paddingVertical: space.md }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Ionicons name="chatbubbles-outline" size={18} color={palette.accent} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySm" numberOfLines={1} style={{ fontWeight: '600' }}>
                      {conversation.title}
                    </AppText>
                    <AppText variant="caption" faint numberOfLines={1}>
                      {conversation.lastMessage ?? 'No messages yet'}
                    </AppText>
                  </View>
                  <AppText variant="caption" faint>
                    {conversation.messageCount}
                  </AppText>
                </View>
              </Card>
            ))}
            {filteredChats.length === 0 ? (
              <EmptyState icon="chatbubble-ellipses-outline" title="No conversations yet" body="Ask a question from any book to start one." />
            ) : null}
          </View>
        </View>
      ) : null}

      {show('lessons') ? (
        <View style={{ marginTop: space.lg }}>
          <AppText variant="heading" serif>
            Lessons & summaries
          </AppText>
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {filteredLessons.slice(0, 10).map((summary) => (
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
                    <AppText variant="caption" faint numberOfLines={1}>
                      {summary.bookTitle} · {summary.kind} · {formatRelative(summary.updatedAt)}
                    </AppText>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={palette.inkFaint} />
                </View>
              </Card>
            ))}
            {filteredLessons.length === 0 ? (
              <EmptyState icon="reader-outline" title="Nothing generated yet" body="Create a summary, lesson or cards from any book." />
            ) : null}
          </View>
        </View>
      ) : null}

      {show('activity') ? (
        <View style={{ marginTop: space.lg }}>
          <AppText variant="heading" serif>
            Activity
          </AppText>
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {(state.data?.activity ?? []).map((event) => (
              <View key={event.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <View
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    backgroundColor: palette.surfaceAlt,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Ionicons name={ACTIVITY_ICON[event.kind] ?? 'ellipse-outline'} size={15} color={palette.inkMuted} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySm" numberOfLines={1}>
                    {ACTIVITY_LABEL[event.kind] ?? event.kind}
                    {event.bookTitle ? ` · ${event.bookTitle}` : ''}
                  </AppText>
                  <AppText variant="caption" faint>
                    {formatRelative(event.createdAt)}
                  </AppText>
                </View>
                {event.minutes > 0 ? (
                  <AppText variant="caption" faint>
                    {event.minutes.toFixed(1)}m
                  </AppText>
                ) : null}
              </View>
            ))}
            {(state.data?.activity.length ?? 0) === 0 ? (
              <EmptyState icon="pulse-outline" title="No activity yet" body="Reading, reviews, notes and lessons appear here." />
            ) : null}
          </View>
        </View>
      ) : null}

      <Divider style={{ marginTop: space.xl }} />
      <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Export or delete your data">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md }}>
          <Ionicons name="download-outline" size={18} color={palette.inkMuted} />
          <AppText variant="bodySm" muted>
            Export or delete your data
          </AppText>
        </View>
      </Pressable>
    </Screen>
  );
}
