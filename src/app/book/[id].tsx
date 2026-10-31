import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Icon } from '@/design/icon';
import {
  Screen,
  AppText,
  Card,
  Cover,
  Button,
  Chip,
  Field,
  Header,
  ProgressBar,
  SectionHeader,
  Divider,
  LoadingBlock,
  ErrorState,
  EmptyState,
  Sheet,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { getBook, setInLibrary } from '@/data/repositories/books';
import { getDocument, getReadingPosition, listHighlights, listSections } from '@/data/repositories/reading';
import { listCards, listSummaries } from '@/data/repositories/learning';
import {
  getOrCreateRendition,
  listRenditions,
  setRenditionEngine,
} from '@/data/repositories/renditions';
import { downloadGutenbergBook } from '@/features/imports/service';
import { conceptSummary, generateCardsForBook, summariseBook, summariseChapter } from '@/features/learning/generate';
import { encodeLocator } from '@/features/reader/readerHtml';
import { bookMastery } from '@/data/repositories/mastery';
import { formatMinutes } from '@/lib/id';
import { DEFAULT_STYLE_ID, getNarrationStyle, NARRATION_STYLES } from '@/features/narration/styles';
import { LENGTH_PRESETS } from '@/features/narration/lengths';
import { MAX_INSTRUCTION_CHARS, instructionHash } from '@/features/narration/script';
import {
  probeNarrationEngines,
  type EngineUnavailableReason,
} from '@/features/narration/engines';
import type {
  NarrationLength,
  NarrationStyleId,
  RenditionEngine,
} from '@/domain/narration';

const ENGINE_ORDER: RenditionEngine[] = ['device', 'remote', 'piper', 'kokoro'];

const ENGINE_REASON_COPY: Record<EngineUnavailableReason, string> = {
  not_installed: 'not installed in this build',
  no_model: 'no voice model installed',
  load_failed: 'voice engine failed to load',
  model_absent: 'no voice model downloaded',
  model_unverified: 'model needs verification',
  needs_extraction: 'model needs extracting',
  no_key: 'add a provider key',
  no_base_url: 'set a provider base URL',
  unsupported_platform: 'not supported on this device',
};

const ENGINE_LABELS: Record<RenditionEngine, string> = {
  device: 'Device voice',
  remote: 'Remote voice',
  piper: 'Piper (local)',
  kokoro: 'Kokoro (local)',
};

function formatRenditionDuration(ms: number | null): string | null {
  if (!ms || ms <= 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** Mirrors the import quality gate's narration table for the sheet UI. */
function narrationMaxLengthFor(
  words: number | null | undefined,
  verdict: string | null | undefined,
): '5' | '15' | '25' | null {
  if (verdict === 'needs_ocr' || verdict === 'unsupported_media') return null;
  const count = words ?? 0;
  if (count < 750) return null;
  if (verdict === 'low_text_quality') return '5';
  if (count >= 3_000) return '25';
  if (count >= 1_800) return '15';
  return '5';
}

const QUALITY_COPY: Record<string, string> = {
  low_text_quality:
    'This text is short or unevenly extracted. Reading works; longer narrations are disabled.',
  needs_ocr:
    'This PDF is a scan with no text layer. OCR is not available in this build; you can still open the original in your device viewer.',
  unsupported_media: 'This edition has no readable text (audio/image only). Try another edition.',
};

export default function BookDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genKind, setGenKind] = useState<'summary' | 'takeaways' | 'lesson' | 'chapter' | 'concepts'>('summary');
  const [genLength, setGenLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [renditionOpen, setRenditionOpen] = useState(false);
  const [styleId, setStyleId] = useState<NarrationStyleId>(DEFAULT_STYLE_ID);
  const [length, setLength] = useState<NarrationLength>('15');
  const [engine, setEngine] = useState<RenditionEngine>('device');
  const [instruction, setInstruction] = useState('');

  useFocusEffect(
    useCallback(() => {
      setTick((t) => t + 1);
    }, []),
  );

  const state = useAsync(async () => {
    const book = await getBook(id);
    if (!book) return { book: null } as const;
    const [document, position, summaries, cards, highlights, renditions] = await Promise.all([
      getDocument(book.id),
      getReadingPosition(book.id),
      listSummaries(book.id),
      listCards(book.id),
      listHighlights(book.id),
      listRenditions(book.id),
    ]);
    const [sections, mastery, probes] = await Promise.all([
      document ? listSections(document.id) : Promise.resolve([]),
      bookMastery(book.id),
      probeNarrationEngines(),
    ]);
    return { book, document, position, summaries, cards, highlights, sections, mastery, renditions, probes } as const;
  }, [id, tick]);

  if (state.loading) {
    return (
      <Screen>
        <Header title="Book" onBack={() => router.back()} />
        <LoadingBlock />
      </Screen>
    );
  }

  if (!state.data?.book) {
    return (
      <Screen>
        <Header title="Book" onBack={() => router.back()} />
        <EmptyState icon="alert-circle-outline" title="Book not found" body="It may have been removed from your library." />
      </Screen>
    );
  }

  const { book, document, position, summaries, cards, highlights, sections, mastery, renditions, probes } = state.data;
  const contentSections = sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => (section.text ?? '').trim().length > 0);
  const guideRendition = renditions.find((rendition) => !!rendition.scriptMd) ?? null;
  const readMinutes = document ? Math.max(1, Math.round((document.wordCount ?? 0) / 220)) : null;
  const canDownload = book.access === 'public_domain' && (!!book.epubUrl || !!book.sourceId);
  const canRead = !!document || canDownload;
  const qualityCopy = document?.error ? QUALITY_COPY[document.error] : null;
  const narrationMaxLength = narrationMaxLengthFor(document?.wordCount, document?.error);

  const run = async (label: string, fn: () => Promise<unknown>) => {
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

  const generate = () =>
    run('generate', async () => {
      if (genKind === 'chapter') {
        if (!chapterId) throw new Error('Choose a chapter first.');
        const result = await summariseChapter(book.id, chapterId, genLength);
        router.push({ pathname: '/summary/[id]', params: { id: result.summaryId } });
        return;
      }
      if (genKind === 'concepts') {
        const result = await conceptSummary(book.id);
        router.push({ pathname: '/summary/[id]', params: { id: result.summaryId } });
        return;
      }
      const result = await summariseBook(book.id, genKind, genLength);
      router.push({ pathname: '/summary/[id]', params: { id: result.summaryId } });
    });

  const startReading = () =>
    run('opening', async () => {
      if (document) {
        router.push({ pathname: '/read/[id]', params: { id: book.id } });
        return;
      }
      if (canDownload) {
        await downloadGutenbergBook(book.id);
        setTick((t) => t + 1);
        router.push({ pathname: '/read/[id]', params: { id: book.id } });
        return;
      }
      throw new Error('No readable file is available for this title. Use the access link to find a copy.');
    });

  const createRendition = () =>
    run('rendition', async () => {
      if (!document) throw new Error('Import or download this book before making a narration.');
      const style = getNarrationStyle(styleId);
      const rendition = await getOrCreateRendition({
        bookId: book.id,
        language: book.language ?? 'en',
        styleId,
        length,
      });
      await setRenditionEngine(rendition.id, {
        engine,
        voice: style.defaultVoices[engine] ?? null,
        model: null,
        instruction: instruction.trim() || null,
        instructionHash: instructionHash(instruction) || null,
      });
      setRenditionOpen(false);
      setTick((t) => t + 1);
      router.push({
        pathname: '/generate/[renditionId]',
        params: { renditionId: rendition.id },
      });
    });

  const openCreateSheet = (rendition?: (typeof renditions)[number]) => {
    if (rendition) {
      setStyleId(getNarrationStyle(rendition.styleId).id);
      setLength(rendition.length);
      setEngine(rendition.engine);
      setInstruction(rendition.instruction ?? '');
    }
    setRenditionOpen(true);
  };

  return (
    <Screen>
      <Header title="" onBack={() => router.back()} />

      <View style={{ flexDirection: 'row', gap: space.lg }}>
        <Cover uri={book.coverUrl} title={book.title} width={118} height={172} />
        <View style={{ flex: 1, gap: 6 }}>
          <AppText variant="title" serif>
            {book.title}
          </AppText>
          <AppText variant="bodySm" muted>
            {book.author ?? 'Unknown author'}
          </AppText>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <Chip label={book.access === 'public_domain' ? 'Public domain' : book.access === 'user_import' ? 'Your copy' : book.access === 'preview' ? 'Preview' : 'Access link'} active />
          </View>
          {qualityCopy ? (
            <AppText variant="caption" color={palette.warm} style={{ marginTop: 4 }}>
              {qualityCopy}
            </AppText>
          ) : null}
          <AppText variant="caption" faint style={{ marginTop: 4 }}>
            {[
              book.publishedYear,
              book.publisher,
              book.pageCount ? `${book.pageCount} pages` : null,
              readMinutes ? `~${formatMinutes(readMinutes)} read` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </AppText>
        </View>
      </View>

      {error ? <ErrorState message={error} /> : null}

      {position && position.percent > 0 ? (
        <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <AppText variant="caption" muted>
              {position.sectionTitle ?? 'Reading'}
            </AppText>
            <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
              {Math.round(position.percent * 100)}%
            </AppText>
          </View>
          <ProgressBar value={position.percent} />
        </Card>
      ) : null}

      {mastery.cards > 0 ? (
        <AppText variant="caption" faint>
          Mastery: {mastery.mature}/{mastery.cards} mature · {mastery.due} due · average stability{' '}
          {mastery.avgStability.toFixed(1)} days
          {mastery.lastReviewedAt ? ` · last reviewed ${new Date(mastery.lastReviewedAt).toLocaleDateString()}` : ''}
        </AppText>
      ) : null}

      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button
          label={document ? 'Continue reading' : canDownload ? 'Download & read' : book.externalUrl ? 'Open at source' : 'No access'}
          icon={document || canDownload ? 'book-outline' : 'open-outline'}
          onPress={() => {
            if (document || canDownload) void startReading();
            else if (book.externalUrl) void WebBrowser.openBrowserAsync(book.externalUrl);
          }}
          loading={busy === 'opening'}
          disabled={!document && !canDownload && !book.externalUrl}
        />
        <Button
          label="Listen"
          icon="headset-outline"
          variant="secondary"
          disabled={!document}
          onPress={() =>
            router.push({
              pathname: '/listen/[id]',
              params: renditions[0]
                ? { id: book.id, rendition: renditions[0].id }
                : { id: book.id },
            })
          }
        />
        <Button
          label="Ask"
          icon="chatbubble-ellipses-outline"
          variant="secondary"
          disabled={!document}
          onPress={() => router.push({ pathname: '/chat/[id]', params: { id: book.id } })}
        />
        <Button
          label={book.inLibrary ? 'Saved' : 'Save'}
          icon={book.inLibrary ? 'checkmark' : 'bookmark-outline'}
          variant="ghost"
          onPress={() =>
            void run('library', async () => {
              await setInLibrary(book.id, !book.inLibrary);
              setTick((t) => t + 1);
            })
          }
          loading={busy === 'library'}
        />
      </View>

      {!canRead && book.externalUrl ? (
        <AppText variant="caption" faint>
          This catalogue entry provides metadata and a link to the official source. Freehaven does not host or
          download this title.
        </AppText>
      ) : null}

      {guideRendition ? (
        <Button
          label="Read the guide"
          icon="sparkles-outline"
          full
          onPress={() =>
            router.push({ pathname: '/guide/[id]', params: { id: guideRendition.id } })
          }
        />
      ) : null}

      {book.description ? (
        <View style={{ gap: 6 }}>
          <SectionHeader title="About" />
          <AppText variant="bodySm" muted>
            {book.description}
          </AppText>
        </View>
      ) : null}

      <Divider />

      <Divider />

      {contentSections.length ? (
        <View style={{ gap: space.sm }}>
          <SectionHeader title="Contents" actionLabel={`${contentSections.length} sections`} />
          {contentSections.slice(0, 8).map(({ section, index }) => (
            <Card
              key={section.id}
              onPress={() =>
                router.push({
                  pathname: '/read/[id]',
                  params: {
                    id: book.id,
                    locator: encodeLocator({ sectionId: section.id, para: 0, start: 0, end: 0 }),
                  },
                })
              }
              style={{ paddingVertical: space.md }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <AppText variant="caption" faint style={{ width: 22 }}>
                  {index + 1}
                </AppText>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySm" numberOfLines={2} style={{ fontWeight: '600' }}>
                    {section.title ?? `Section ${index + 1}`}
                  </AppText>
                  <AppText variant="caption" faint>
                    {section.startPage ? `Page ${section.startPage}` : 'Chapter'}
                  </AppText>
                </View>
                <Icon name="chevron-forward" size={16} color={palette.inkFaint} />
              </View>
            </Card>
          ))}
          {contentSections.length > 8 ? (
            <AppText variant="caption" faint>
              Showing the first 8. Open the reader for the full table of contents.
            </AppText>
          ) : null}
        </View>
      ) : null}

      <SectionHeader
        title="Renditions"
        actionLabel={document ? 'Narrate' : undefined}
        onAction={document ? () => openCreateSheet() : undefined}
      />
      <AppText variant="caption" faint style={{ marginBottom: space.sm }}>
        Narrations of this book, each with its own style, length and audio.
      </AppText>
      <View style={{ gap: space.sm }}>
        {renditions.length ? (
          renditions.map((rendition) => {
            const style = getNarrationStyle(rendition.styleId);
            const canListen =
              rendition.status === 'ready' ||
              rendition.status === 'script_ready' ||
              rendition.status === 'synthesising';
            return (
              <Card key={rendition.id} style={{ paddingVertical: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Icon name="headset-outline" size={18} color={palette.accent} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySm" numberOfLines={1} style={{ fontWeight: '600' }}>
                      {style.label} · {rendition.length} min
                    </AppText>
                    <AppText variant="caption" faint numberOfLines={1}>
                      {ENGINE_LABELS[rendition.engine]}
                      {formatRenditionDuration(rendition.durationMs)
                        ? ` · ${formatRenditionDuration(rendition.durationMs)}`
                        : ''}
                      {' · '}
                      {rendition.status.replace('_', ' ')}
                      {rendition.wordCount ? ` · ${rendition.wordCount} words` : ''}
                    </AppText>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                    {rendition.scriptMd ? (
                      <Button
                        label="Guide"
                        size="sm"
                        variant="ghost"
                        onPress={() =>
                          router.push({ pathname: '/guide/[id]', params: { id: rendition.id } })
                        }
                      />
                    ) : null}
                    <Button
                      label={canListen ? 'Listen' : 'Create'}
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        if (canListen) {
                          router.push({
                            pathname: '/listen/[id]',
                            params: { id: book.id, rendition: rendition.id },
                          });
                        } else {
                          openCreateSheet(rendition);
                        }
                      }}
                    />
                  </View>
                </View>
              </Card>
            );
          })
        ) : (
          <AppText variant="caption" faint>
            No narrations yet. Pick a style and length to make one.
          </AppText>
        )}
        <Button
          label="Narrate this book"
          icon="mic-outline"
          variant="secondary"
          disabled={!document}
          onPress={() => openCreateSheet()}
        />
      </View>

      <SectionHeader title="Make something" />
      <AppText variant="caption" faint style={{ marginBottom: space.sm }}>
        Generated from the text you can lawfully open. You can edit or delete everything afterwards.
      </AppText>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button
          label="Generate"
          icon="sparkles-outline"
          variant="secondary"
          size="sm"
          disabled={!document}
          onPress={() => setGenOpen(true)}
        />
        <Button
          label="Build cards"
          icon="albums-outline"
          variant="secondary"
          size="sm"
          loading={busy === 'cards'}
          disabled={!document || !!busy}
          onPress={() =>
            void run('cards', async () => {
              const created = await generateCardsForBook(book.id, 10);
              setTick((t) => t + 1);
              router.push('/review');
              return created;
            })
          }
        />
      </View>

      {cards.length ? (
        <Card onPress={() => router.push('/review')} style={{ paddingVertical: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Icon name="albums-outline" size={18} color={palette.accent} />
            <AppText variant="bodySm" style={{ flex: 1 }}>
              {cards.length} card{cards.length === 1 ? '' : 's'} from this book
            </AppText>
            <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
              Review →
            </AppText>
          </View>
        </Card>
      ) : null}

      {summaries.length ? (
        <View style={{ gap: space.sm }}>
          <AppText variant="label" muted>
            Generated
          </AppText>
          {summaries.map((summary) => (
            <Card
              key={summary.id}
              onPress={() => router.push({ pathname: '/summary/[id]', params: { id: summary.id } })}
              style={{ paddingVertical: space.md }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <Icon name="reader-outline" size={18} color={palette.warm} />
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySm" numberOfLines={1} style={{ fontWeight: '600' }}>
                    {summary.title}
                  </AppText>
                  <AppText variant="caption" faint>
                    {summary.provider} · {new Date(summary.createdAt).toLocaleDateString()}
                  </AppText>
                </View>
                <Icon name="chevron-forward" size={16} color={palette.inkFaint} />
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {highlights.length ? (
        <View style={{ gap: 6 }}>
          <AppText variant="label" muted>
            {highlights.length} highlight{highlights.length === 1 ? '' : 's'}
          </AppText>
          {highlights.slice(0, 3).map((highlight) => (
            <Card key={highlight.id} style={{ paddingVertical: space.sm }}>
              <AppText variant="caption" numberOfLines={2}>
                “{highlight.quote}”
              </AppText>
            </Card>
          ))}
        </View>
      ) : null}

      {book.externalUrl || book.epubUrl ? (
        <View style={{ gap: space.sm }}>
          <Divider />
          <AppText variant="caption" faint>
            {book.license ?? 'Licence information is provided by the catalogue.'}
          </AppText>
          {book.externalUrl ? (
            <Button
              label="Open official source"
              icon="open-outline"
              variant="ghost"
              size="sm"
              onPress={() => void WebBrowser.openBrowserAsync(book.externalUrl!)}
            />
          ) : null}
        </View>
      ) : null}

      <Sheet visible={genOpen} onClose={() => setGenOpen(false)} title="Generate from this book">
        <AppText variant="label" muted>
          What should it be?
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {(
            [
              { id: 'summary', label: 'Summary' },
              { id: 'takeaways', label: 'Takeaways' },
              { id: 'lesson', label: 'Lesson' },
              { id: 'concepts', label: 'Concepts' },
              { id: 'chapter', label: 'Chapter' },
            ] as const
          ).map((option) => (
            <Chip
              key={option.id}
              label={option.label}
              active={genKind === option.id}
              onPress={() => {
                setGenKind(option.id);
                if (option.id === 'chapter' && !chapterId && sections[0]) setChapterId(sections[0].id);
              }}
            />
          ))}
        </View>

        {genKind === 'chapter' ? (
          <View style={{ gap: space.sm }}>
            <AppText variant="label" muted>
              Chapter
            </AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {sections.slice(0, 24).map((section, i) => (
                <Chip
                  key={section.id}
                  label={section.title ? section.title.slice(0, 26) : `Section ${i + 1}`}
                  active={chapterId === section.id}
                  onPress={() => setChapterId(section.id)}
                />
              ))}
            </View>
            {sections.length > 24 ? (
              <AppText variant="caption" faint>
                Showing the first 24 sections. Use the reader’s contents sheet for the full list.
              </AppText>
            ) : null}
          </View>
        ) : null}

        <AppText variant="label" muted>
          Length
        </AppText>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {(['short', 'medium', 'long'] as const).map((option) => (
            <Chip key={option} label={option[0].toUpperCase() + option.slice(1)} active={genLength === option} onPress={() => setGenLength(option)} />
          ))}
        </View>

        <Button
          label="Generate"
          icon="sparkles-outline"
          onPress={() => void generate()}
          loading={busy === 'generate'}
          disabled={busy === 'generate' || (genKind === 'chapter' && !chapterId)}
          full
        />
        <AppText variant="caption" faint>
          Everything is generated from the text you already have and cites its passages. On-device extraction is used
          unless you configured a remote model.
        </AppText>
      </Sheet>

      <Sheet visible={renditionOpen} onClose={() => setRenditionOpen(false)} title="Narrate this book">
        {!document ? (
          <AppText variant="caption" color={palette.danger}>
            This book has no document yet. Download or import a readable file first.
          </AppText>
        ) : null}

        <AppText variant="label" muted>
          Style
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {NARRATION_STYLES.map((style) => (
            <Chip
              key={style.id}
              label={style.label}
              active={styleId === style.id}
              onPress={() => {
                setStyleId(style.id);
                setLength(style.defaultLength);
              }}
            />
          ))}
        </View>
        <AppText variant="caption" faint>
          {getNarrationStyle(styleId).persona}
        </AppText>

        <AppText variant="label" muted>
          Length
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {LENGTH_PRESETS.map((preset) => {
            const tooLong = !narrationMaxLength || Number(preset.id) > Number(narrationMaxLength);
            return (
              <Chip
                key={preset.id}
                label={`${preset.minutes} min · ${preset.words} words`}
                active={length === preset.id}
                onPress={tooLong ? undefined : () => setLength(preset.id)}
              />
            );
          })}
        </View>
        {document?.error && QUALITY_COPY[document.error] ? (
          <AppText variant="caption" faint>
            {QUALITY_COPY[document.error]}
            {narrationMaxLength ? ` Narration is limited to ${narrationMaxLength} minutes.` : ''}
          </AppText>
        ) : null}

        <AppText variant="label" muted>
          Engine
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {ENGINE_ORDER.map((candidate) => {
            const availability = probes[candidate];
            const enabled = candidate === 'device' || !!availability?.available;
            const reason =
              availability && !availability.available
                ? ENGINE_REASON_COPY[availability.reason]
                : null;
            return (
              <Chip
                key={candidate}
                label={enabled ? ENGINE_LABELS[candidate] : `${ENGINE_LABELS[candidate]} · ${reason}`}
                active={engine === candidate}
                onPress={enabled ? () => setEngine(candidate) : undefined}
              />
            );
          })}
        </View>
        <AppText variant="caption" faint>
          Device narration works offline. Neural and remote engines appear as they are installed.
        </AppText>

        <Field
          label="Instruction"
          value={instruction}
          onChangeText={(value) => setInstruction(value.slice(0, MAX_INSTRUCTION_CHARS))}
          placeholder="Optional: pace, emphasis, who it is for…"
          maxLength={MAX_INSTRUCTION_CHARS}
          hint={`${instruction.length}/${MAX_INSTRUCTION_CHARS}`}
        />

        <Button
          label="Create narration"
          icon="mic-outline"
          onPress={() => void createRendition()}
          loading={busy === 'rendition'}
          disabled={
            !document ||
            busy === 'rendition' ||
            !(engine === 'device' || probes[engine]?.available)
          }
          full
        />
        <AppText variant="caption" faint>
          Creating a narration writes the script and segments. You choose when to generate audio on the Listen screen.
        </AppText>
      </Sheet>
    </Screen>
  );
}
