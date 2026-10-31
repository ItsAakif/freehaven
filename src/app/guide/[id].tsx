import React, { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { BrandLockup } from '@/design/brand';
import {
  Screen,
  AppText,
  Card,
  Button,
  Header,
  Divider,
  EmptyState,
  LoadingBlock,
} from '@/design/ui';
import { layout, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { useAsync } from '@/hooks/useAsync';
import { getBook } from '@/data/repositories/books';
import { getRendition, listSegments } from '@/data/repositories/renditions';
import { getNarrationStyle } from '@/features/narration/styles';
import { parseGuideScript, type GuideBlock } from '@/features/narration/guideScript';
import { writeGuidePdf } from '@/features/export/guidePdf';

export default function GuideScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useAsync(async () => {
    const rendition = await getRendition(id);
    if (!rendition) return { rendition: null } as const;
    const [book, segments] = await Promise.all([
      getBook(rendition.bookId),
      listSegments(rendition.id),
    ]);
    return { rendition, book, segments } as const;
  }, [id]);

  if (state.loading) {
    return (
      <Screen>
        <Header title="Guide" onBack={() => router.back()} />
        <LoadingBlock label="Opening the guide…" />
      </Screen>
    );
  }

  if (!state.data?.rendition) {
    return (
      <Screen>
        <Header title="Guide" onBack={() => router.back()} />
        <EmptyState
          icon="reader-outline"
          title="This guide is gone"
          body="The narration may have been deleted."
          actionLabel="Go back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const { rendition, book, segments } = state.data;
  const style = getNarrationStyle(rendition.styleId);
  const parsed = parseGuideScript(rendition.scriptMd ?? '');
  const usedExtract = (rendition.scriptProvider ?? '').endsWith('+extract');

  if (!rendition.scriptMd?.trim()) {
    return (
      <Screen>
        <Header
          title={book?.title ?? 'Guide'}
          subtitle="Freehaven guide"
          onBack={() => router.back()}
        />
        <EmptyState
          icon="sparkles-outline"
          title="No guide yet"
          body={`Write the ${style.label.toLowerCase()} script for this narration, then come back to read and share the guide.`}
          actionLabel="Open generation"
          onAction={() =>
            router.push({
              pathname: '/generate/[renditionId]',
              params: { renditionId: rendition.id },
            })
          }
        />
      </Screen>
    );
  }

  const download = async () => {
    if (!book) return;
    setBusy(true);
    setError(null);
    try {
      const uri = await writeGuidePdf({
        id: rendition.id,
        bookTitle: book.title,
        subtitle: `${style.label} · ${rendition.length} min`,
        intro: parsed.intro,
        topics: parsed.topics,
        generatedAt: Date.now(),
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          UTI: 'com.adobe.pdf',
          dialogTitle: 'Freehaven guide',
        });
      } else {
        setError('Sharing is not available on this device.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: space.lg }}>
        <Header
          title={book?.title ?? 'Guide'}
          subtitle={`${style.label} · ${rendition.length} min · Freehaven guide`}
          onBack={() => router.back()}
          right={<BrandLockup height={36} />}
        />

        <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
          <Button
            label="Download PDF"
            icon="download-outline"
            size="sm"
            loading={busy}
            onPress={() => void download()}
          />
          <Button
            label="Listen"
            icon="headset-outline"
            variant="secondary"
            size="sm"
            onPress={() =>
              router.push({
                pathname: '/listen/[id]',
                params: { id: rendition.bookId, rendition: rendition.id },
              })
            }
          />
        </View>

        {error ? (
          <AppText variant="caption" color={palette.danger}>
            {error}
          </AppText>
        ) : null}

        <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
          <AppText variant="caption" muted style={{ fontWeight: '700' }}>
            FREEHAVEN GUIDE
          </AppText>
          <AppText variant="subheading" serif style={{ marginTop: 4 }}>
            {book?.author ? `${book.title} · ${book.author}` : book?.title}
          </AppText>
          <AppText variant="caption" faint style={{ marginTop: 4 }}>
            {style.label} · {rendition.length} min ·{' '}
            {rendition.wordCount ? `${rendition.wordCount.toLocaleString()} words` : 'script'}
            {segments.length
              ? ` · ${segments.length} spoken segment${segments.length === 1 ? '' : 's'}`
              : ''}
          </AppText>
        </Card>

        {parsed.intro.length ? (
          <View style={{ gap: space.sm }}>
            {parsed.intro.map((block, index) => (
              <Block key={`intro-${index}`} block={block} />
            ))}
          </View>
        ) : (
          <AppText variant="body" serif muted>
            {style.persona}
          </AppText>
        )}

        {usedExtract ? (
          <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.line }}>
            <AppText variant="bodySm" muted>
              Part of this guide used an on-device extract because the model returned an empty
              response. Re-generate for a full model summary.
            </AppText>
          </Card>
        ) : null}

        {parsed.topics.map((topic, index) => (
          <View key={`${index}-${topic.title}`} style={{ gap: space.sm, marginTop: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.md }}>
              <View
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: palette.accentSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
                  {index + 1}
                </AppText>
              </View>
              <AppText variant="heading" serif color={palette.accent} style={{ flex: 1 }}>
                {topic.title}
              </AppText>
            </View>
            <View style={{ gap: space.sm, paddingLeft: 38 }}>
              {topic.blocks.map((block, blockIndex) => (
                <Block key={`${index}-${blockIndex}`} block={block} />
              ))}
            </View>
          </View>
        ))}

        <Divider />

        <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
          <Button
            label="Download PDF"
            icon="download-outline"
            loading={busy}
            onPress={() => void download()}
          />
          <Button
            label="Listen"
            icon="headset-outline"
            variant="secondary"
            onPress={() =>
              router.push({
                pathname: '/listen/[id]',
                params: { id: rendition.bookId, rendition: rendition.id },
              })
            }
          />
        </View>

        <AppText variant="caption" faint>
          Generated from the text on this device. Always verify against the source.
        </AppText>
      </View>
    </Screen>
  );
}

function Block({ block }: { block: GuideBlock }) {
  const { palette } = useTheme();
  if (block.kind === 'quote') {
    return (
      <View
        style={{
          borderLeftWidth: 2,
          borderLeftColor: palette.accent,
          paddingLeft: space.md,
          paddingVertical: 2,
        }}
      >
        <AppText variant="bodySm" serif muted style={{ fontStyle: 'italic' }}>
          {block.text}
        </AppText>
      </View>
    );
  }
  return (
    <AppText variant="body" serif>
      {block.text}
    </AppText>
  );
}
