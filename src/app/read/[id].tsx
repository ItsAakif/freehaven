import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { File as FsFile } from 'expo-file-system';
import { WebView as RNWebView } from 'react-native-webview';
import { Icon } from '@/design/icon';
import {
  Screen,
  AppText,
  Card,
  Button,
  IconButton,
  Sheet,
  Chip,
  Field,
  EmptyState,
  LoadingBlock,
  ProgressBar,
  Divider,
} from '@/design/ui';
import { radius, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { getBook } from '@/data/repositories/books';
import {
  addBookmark,
  addHighlight,
  createBookmarkFolder,
  deleteHighlight,
  getDocument,
  getReadingPosition,
  listBookmarkFolders,
  listHighlights,
  listSections,
  saveReadingPosition,
  searchBookChunks,
  updateHighlightNote,
} from '@/data/repositories/reading';
import {
  buildReaderHtml,
  decodeLocator,
  DEFAULT_READER_SETTINGS,
  encodeLocator,
  splitParagraphs,
  applyHighlights,
  type ReaderHighlight,
  type ReaderSettings,
} from '@/features/reader/readerHtml';
import type { Highlight, Section } from '@/domain/types';

// react-native-webview's generic props do not compose with React 19 typings here.
const WebView = RNWebView as unknown as React.ComponentType<any>;

type ReaderMessage =
  | { type: 'ready' }
  | { type: 'scroll'; pct: number }
  | { type: 'selection'; para: number; start: number; end: number; text: string }
  | { type: 'mark'; id: string }
  | { type: 'jump'; found: boolean };

export default function ReaderScreen() {  const { id, locator: locatorParam } = useLocalSearchParams<{ id: string; locator?: string }>();
  const { palette } = useTheme();
  const webRef = useRef<any>(null);
  const scrollRef = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [index, setIndex] = useState(0);
  const [scrollPct, setScrollPct] = useState(0);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState<Highlight | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<{ id: string; sectionId: string | null; text: string; page: number | null }[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [jumpText, setJumpText] = useState<string | null>(null);
  const [bookmarkOpen, setBookmarkOpen] = useState(false);
  const [bookmarkLabel, setBookmarkLabel] = useState('');
  const [bookmarkFolder, setBookmarkFolder] = useState<string | null>(null);
  const [bookmarkTags, setBookmarkTags] = useState('');
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [newFolder, setNewFolder] = useState('');

  const state = useAsync(async () => {
    const book = await getBook(id);
    if (!book) return { book: null } as const;
    const document = await getDocument(book.id);
    if (!document) return { book, document: null, sections: [], position: null } as const;
    const [sections, position, highlightsForBook] = await Promise.all([
      listSections(document.id),
      getReadingPosition(book.id),
      listHighlights(book.id),
    ]);
    const bookmarkFolders = await listBookmarkFolders();
    setFolders(bookmarkFolders.map((f) => ({ id: f.id, name: f.name })));
    return { book, document, sections, position, highlightsForBook } as const;
  }, [id]);

  useEffect(() => {
    if (!state.data?.sections?.length) return;
    setHighlights(state.data.highlightsForBook ?? []);
    const initial = decodeLocator(locatorParam) ?? decodeLocator(state.data.position?.locator ?? null);
    const found = initial ? state.data.sections.findIndex((s) => s.id === initial.sectionId) : -1;
    setIndex(found >= 0 ? found : 0);
    if (initial?.quote) setJumpText(initial.quote);
  }, [state.data, locatorParam]);

  const sections = useMemo(() => (state.data?.sections ?? []) as Section[], [state.data?.sections]);
  const section = sections[index];
  const paragraphs = useMemo(() => splitParagraphs(section?.text ?? ''), [section?.text]);

  const sectionHighlights: ReaderHighlight[] = useMemo(() => {
    if (!section) return [];
    return highlights
      .map((h) => {
        const loc = decodeLocator(h.locator);
        if (!loc || loc.sectionId !== section.id) return null;
        return { id: h.id, para: loc.para, start: loc.start, end: loc.end, color: h.color };
      })
      .filter((h): h is ReaderHighlight => !!h);
  }, [highlights, section]);

  const html = useMemo(() => {
    if (!section) return '';
    return buildReaderHtml({
      title: state.data?.book?.title ?? '',
      sectionTitle: section.title ?? `Section ${index + 1}`,
      paragraphs,
      highlights: sectionHighlights,
      settings,
    });
  }, [section, paragraphs, sectionHighlights, settings, state.data?.book?.title, index]);

  const persistPosition = useCallback(
    (sectionIndex: number, withinSection: number) => {
      if (!state.data?.book || !sections.length) return;
      const percent = Math.min(1, (sectionIndex + withinSection) / Math.max(1, sections.length));
      void saveReadingPosition({
        bookId: state.data.book.id,
        locator: encodeLocator({ sectionId: sections[sectionIndex].id, para: 0, start: 0, end: 0 }),
        percent,
        sectionTitle: sections[sectionIndex].title ?? null,
        updatedAt: Date.now(),
      });
    },
    [sections, state.data?.book],
  );

  const onMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let message: ReaderMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as ReaderMessage;
      } catch {
        return;
      }
      if (message.type === 'ready') {
        if (jumpText) {
          webRef.current?.injectJavaScript(`window.__jumpTo(${JSON.stringify(jumpText)}); true;`);
          setJumpText(null);
        }
        return;
      }
      if (message.type === 'scroll') {
        scrollRef.current = message.pct;
        setScrollPct(message.pct);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => persistPosition(index, message.pct), 1200);
        return;
      }
      if (message.type === 'selection') {
        const quote = message.text.trim();
        if (quote.length < 2) return;
        void (async () => {
          const created = await addHighlight({
            bookId: id,
            locator: encodeLocator({
              sectionId: section.id,
              para: message.para,
              start: message.start,
              end: message.end,
              quote: quote.slice(0, 120),
            }),
            quote,
            color: 'gold',
          });
          setHighlights((prev) => [created, ...prev]);
          setToast('Highlight saved');
          const paragraph = paragraphs[message.para] ?? '';
          const updatedLoc = decodeLocator(created.locator);
          const all = [
            ...sectionHighlights,
            { id: created.id, para: message.para, start: message.start, end: message.end, color: 'gold' },
          ];
          const inner = applyHighlights(paragraph, all.filter((h) => h.para === message.para));
          webRef.current?.injectJavaScript(
            `(function(){var p=document.querySelector('p[data-p="${message.para}"]'); if(p){p.innerHTML=${JSON.stringify(
              inner,
            )};} return true;})(); true;`,
          );
          void updatedLoc;
        })();
        return;
      }
      if (message.type === 'mark') {
        const found = highlights.find((h) => h.id === message.id);
        if (found) {
          setNoteOpen(found);
          setNoteDraft(found.note ?? '');
        }
        return;
      }
    },
    [highlights, id, index, jumpText, paragraphs, persistPosition, section, sectionHighlights],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      if (toast) setToast(null);
    }, 2200);
    return () => clearInterval(timer);
  }, [toast]);

  const changeSection = (next: number) => {
    const clamped = Math.max(0, Math.min(sections.length - 1, next));
    scrollRef.current = 0;
    setScrollPct(0);
    setIndex(clamped);
    setTocOpen(false);
    persistPosition(clamped, 0);
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    const hits = await searchBookChunks(id, searchQuery.trim(), 20);
    setResults(
      hits.map((h) => ({
        id: h.id,
        sectionId: h.sectionId ?? null,
        text: h.text,
        page: h.page ?? null,
      })),
    );
  };

  const jumpToResult = (result: { sectionId: string | null; text: string }) => {
    const target = sections.findIndex((s) => s.id === result.sectionId);
    if (target >= 0) {
      setIndex(target);
      setJumpText(result.text.slice(0, 60));
      setSearchOpen(false);
    }
  };

  if (state.loading) {
    return (
      <Screen>
        <LoadingBlock label="Opening the reader…" />
      </Screen>
    );
  }

  if (!state.data?.book || !sections.length) {
    return (
      <Screen>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: space.sm }}>
          <IconButton name="chevron-back" label="Back" onPress={() => router.back()} />
        </View>
        <EmptyState
          icon="book-outline"
          title="Nothing to read yet"
          body="This title has no extracted text. Import a file or download a public-domain edition first."
          actionLabel="Go back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const percent = Math.round(((index + scrollPct) / Math.max(1, sections.length)) * 100);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <View
        style={{
          paddingTop: 48,
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          backgroundColor: palette.bg,
        }}
      >
        <IconButton name="chevron-back" label="Close reader" onPress={() => router.back()} />
        <View style={{ flex: 1 }}>
          <AppText variant="caption" muted numberOfLines={1}>
            {state.data.book.title}
          </AppText>
          <AppText variant="label" numberOfLines={1} style={{ fontWeight: '600' }}>
            {section.title ?? `Section ${index + 1}`}
          </AppText>
        </View>
        <IconButton name="search" label="Search in book" onPress={() => setSearchOpen(true)} />
        {state.data?.document?.format === 'pdf' && state.data.document.filePath ? (
          <IconButton
            name="document-outline"
            label="Open the original PDF"
            onPress={() =>
              void (async () => {
                try {
                  await new FsFile(state.data!.document!.filePath!).preview();
                } catch {
                  setToast('No PDF viewer is available on this device.');
                }
              })()
            }
          />
        ) : null}
        <IconButton name="list" label="Table of contents" onPress={() => setTocOpen(true)} />
        <IconButton name="text" label="Reading settings" onPress={() => setSettingsOpen(true)} />
      </View>

      <View style={{ flex: 1 }}>
        <WebView
          ref={webRef}
          key={`${section.id}-${settings.fontSize}-${settings.theme}-${settings.fontFamily}-${settings.lineHeight}`}
          originWhitelist={['about:blank']}
          source={{ html }}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled={false}
          allowsLinkPreview={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request: { url: string }) =>
            request.url.startsWith('about:blank') || request.url === 'about:blank'
          }
          style={{ backgroundColor: palette.bg }}
          androidLayerType="hardware"
        />
      </View>

      <View
        style={{
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
          paddingBottom: 34,
          borderTopWidth: 1,
          borderTopColor: palette.line,
          backgroundColor: palette.bgElevated,
          gap: space.sm,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <ProgressBar value={percent / 100} style={{ flex: 1 }} />
          <AppText variant="caption" faint>
            {percent}%
          </AppText>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Button label="Prev" variant="ghost" size="sm" icon="chevron-back" disabled={index === 0} onPress={() => changeSection(index - 1)} />
          <View style={{ flexDirection: 'row', gap: space.xs }}>
            <IconButton
              name="bookmark-outline"
              label="Bookmark this section"
              onPress={() => {
                setBookmarkLabel(section.title ?? `Section ${index + 1}`);
                setBookmarkFolder(null);
                setBookmarkTags('');
                setBookmarkOpen(true);
              }}
            />
            <IconButton name="color-wand-outline" label="Ask about this book" onPress={() => router.push({ pathname: '/chat/[id]', params: { id } })} />
            <IconButton name="headset-outline" label="Listen to this book" onPress={() => router.push({ pathname: '/listen/[id]', params: { id } })} />
          </View>
          <Button
            label="Next"
            variant="ghost"
            size="sm"
            icon="chevron-forward"
            disabled={index >= sections.length - 1}
            onPress={() => changeSection(index + 1)}
          />
        </View>
      </View>

      {toast ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            bottom: 130,
            alignSelf: 'center',
            backgroundColor: palette.ink,
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
            borderRadius: radius.pill,
          }}
        >
          <AppText variant="caption" color={palette.bg}>
            {toast}
          </AppText>
        </View>
      ) : null}

      <Sheet visible={tocOpen} onClose={() => setTocOpen(false)} title="Contents">
        {sections.map((item, i) => (
          <Pressable
            key={item.id}
            onPress={() => changeSection(i)}
            accessibilityRole="button"
            accessibilityLabel={item.title ?? `Section ${i + 1}`}
            style={{ paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: palette.line }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <AppText variant="caption" faint style={{ width: 26 }}>
                {i + 1}
              </AppText>
              <AppText variant="bodySm" numberOfLines={2} style={{ flex: 1, fontWeight: i === index ? '700' : '400' }}>
                {item.title ?? `Section ${i + 1}`}
              </AppText>
              {i === index ? <Icon name="ellipse" size={7} color={palette.accent} /> : null}
            </View>
          </Pressable>
        ))}
      </Sheet>

      <Sheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} title="Reading">
        <AppText variant="label" muted>
          Text size
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {[
            { label: 'A', size: 16 },
            { label: 'A', size: 18 },
            { label: 'A', size: 21 },
            { label: 'A', size: 24 },
          ].map((option, i) => (
            <Chip
              key={option.size}
              label={option.label}
              active={settings.fontSize === option.size}
              onPress={() => setSettings({ ...settings, fontSize: option.size })}
            />
          ))}
        </View>
        <AppText variant="label" muted>
          Theme
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {(['reading', 'light', 'dark'] as const).map((theme) => (
            <Chip key={theme} label={theme[0].toUpperCase() + theme.slice(1)} active={settings.theme === theme} onPress={() => setSettings({ ...settings, theme })} />
          ))}
        </View>
        <AppText variant="label" muted>
          Typeface
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Chip label="Serif" active={settings.fontFamily === 'serif'} onPress={() => setSettings({ ...settings, fontFamily: 'serif' })} />
          <Chip label="Sans" active={settings.fontFamily === 'sans'} onPress={() => setSettings({ ...settings, fontFamily: 'sans' })} />
        </View>
        <AppText variant="label" muted>
          Line spacing
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {[1.45, 1.65, 1.85].map((lh) => (
            <Chip key={lh} label={`${lh}×`} active={settings.lineHeight === lh} onPress={() => setSettings({ ...settings, lineHeight: lh })} />
          ))}
        </View>
      </Sheet>

      <Sheet visible={searchOpen} onClose={() => setSearchOpen(false)} title="Search in book">
        <Field
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="A word or phrase"
          returnKeyType="search"
          onSubmitEditing={() => void runSearch()}
          autoFocus
        />
        <Button label="Search" variant="secondary" onPress={() => void runSearch()} />
        <Divider />
        {results.length === 0 ? (
          <AppText variant="caption" faint>
            Results are ranked with full-text search across the indexed passages.
          </AppText>
        ) : null}
        {results.map((result) => (
          <Pressable
            key={result.id}
            onPress={() => jumpToResult(result)}
            accessibilityRole="button"
            accessibilityLabel={`Result: ${result.text.slice(0, 60)}`}
            style={{ paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: palette.line }}
          >
            <AppText variant="bodySm" numberOfLines={3}>
              {result.text}
            </AppText>
            {result.page ? (
              <AppText variant="caption" faint style={{ marginTop: 2 }}>
                Page {result.page}
              </AppText>
            ) : null}
          </Pressable>
        ))}
      </Sheet>

      <Sheet visible={bookmarkOpen} onClose={() => setBookmarkOpen(false)} title="New bookmark">
        <Field label="Label" value={bookmarkLabel} onChangeText={setBookmarkLabel} placeholder="Why keep this place?" />
        <AppText variant="label" muted>
          Folder
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <Chip label="None" active={!bookmarkFolder} onPress={() => setBookmarkFolder(null)} />
          {folders.map((folder) => (
            <Chip
              key={folder.id}
              label={folder.name}
              active={bookmarkFolder === folder.id}
              onPress={() => setBookmarkFolder(folder.id)}
            />
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <Field label="New folder" value={newFolder} onChangeText={setNewFolder} placeholder="e.g. Thesis reading" />
          </View>
          <Button
            label="Add"
            variant="secondary"
            size="sm"
            disabled={!newFolder.trim()}
            onPress={() =>
              void (async () => {
                const folder = await createBookmarkFolder(newFolder.trim());
                setFolders((current) => [...current, { id: folder.id, name: folder.name }]);
                setBookmarkFolder(folder.id);
                setNewFolder('');
              })()
            }
          />
        </View>
        <Field
          label="Tags"
          value={bookmarkTags}
          onChangeText={setBookmarkTags}
          placeholder="comma, separated, tags"
          hint="Tags make bookmarks searchable in Mindspace."
        />
        <Button
          label="Save bookmark"
          full
          onPress={() =>
            void (async () => {
              await addBookmark(id, encodeLocator({ sectionId: section.id, para: 0, start: 0, end: 0 }), bookmarkLabel, {
                folderId: bookmarkFolder,
                tags: bookmarkTags
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              });
              setBookmarkOpen(false);
              setToast('Bookmark saved');
            })()
          }
        />
      </Sheet>

      <Sheet visible={!!noteOpen} onClose={() => setNoteOpen(null)} title="Highlight">
        <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
          <AppText variant="bodySm" serif>
            “{noteOpen?.quote}”
          </AppText>
        </Card>
        <Field label="Your note" value={noteDraft} onChangeText={setNoteDraft} multiline placeholder="Why does this matter?" />
        <Button
          label="Save note"
          onPress={() =>
            void (async () => {
              if (!noteOpen) return;
              await updateHighlightNote(noteOpen.id, noteDraft);
              setHighlights((prev) => prev.map((h) => (h.id === noteOpen.id ? { ...h, note: noteDraft } : h)));
              setNoteOpen(null);
              setToast('Note saved');
            })()
          }
          full
        />
        <Button
          label="Delete highlight"
          variant="danger"
          onPress={() =>
            void (async () => {
              if (!noteOpen) return;
              await deleteHighlight(noteOpen.id);
              setHighlights((prev) => prev.filter((h) => h.id !== noteOpen.id));
              setNoteOpen(null);
              setToast('Highlight removed');
            })()
          }
          full
        />
      </Sheet>
    </View>
  );
}
