import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { Icon } from '@/design/icon';
import {
  Screen,
  AppText,
  Card,
  Button,
  Field,
  Header,
  ErrorState,
  Divider,
} from '@/design/ui';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { importArticle, importDocument, importTextDocument, type ImportPhase } from '@/features/imports/service';

const PHASE_LABEL: Record<ImportPhase, string> = {
  copying: 'Copying the file…',
  parsing: 'Reading the document…',
  indexing: 'Indexing passages for search…',
  done: 'Ready.',
};

export default function ImportScreen() {
  const { palette } = useTheme();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ImportPhase | null>(null);
  const [detail, setDetail] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const go = (bookId: string) => {
    router.replace({ pathname: '/book/[id]', params: { id: bookId } });
  };

  const run = async (fn: () => Promise<{ bookId: string; warnings?: string[] }>) => {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const result = await fn();
      setWarnings(result.warnings ?? []);
      setPhase('done');
      go(result.bookId);
    } catch (e) {
      setError((e as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/epub+zip', 'application/pdf', 'text/plain', 'text/markdown'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled || !result.assets.length) return;
    const asset = result.assets[0];
    await run(() =>
      importDocument(
        { uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size ?? null },
        {
          onProgress: (p, d) => {
            setPhase(p);
            setDetail(d ?? '');
          },
        },
      ),
    );
  };

  return (
    <Screen>
      <Header title="Import" onBack={() => router.back()} subtitle="Your files stay on your device." />

      <Card style={{ backgroundColor: palette.accent, borderColor: palette.accent }}>
        <Icon name="shield-checkmark-outline" size={22} color={palette.accentInk} />
        <AppText variant="subheading" serif color={palette.accentInk} style={{ marginTop: space.sm }}>
          Local by default
        </AppText>
        <AppText variant="caption" color={palette.accentInk} style={{ opacity: 0.85, marginTop: 4 }}>
          Imported documents, extracted text and notes are stored in Freehaven’s local database. Nothing is uploaded
          unless you explicitly send a request to a model you configured.
        </AppText>
      </Card>

      <Button label="Choose EPUB, PDF or text file" icon="folder-open-outline" onPress={() => void pickFile()} loading={busy} full />

      {busy && phase ? (
        <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
          <AppText variant="bodySm" style={{ fontWeight: '600' }}>
            {PHASE_LABEL[phase]}
          </AppText>
          {detail ? (
            <AppText variant="caption" faint>
              {detail}
            </AppText>
          ) : null}
        </Card>
      ) : null}

      {error ? <ErrorState message={error} /> : null}
      {warnings.length ? (
        <Card style={{ backgroundColor: palette.warmSoft, borderColor: palette.warmSoft }}>
          {warnings.map((w) => (
            <AppText key={w} variant="caption" muted>
              • {w}
            </AppText>
          ))}
        </Card>
      ) : null}

      <Divider style={{ marginVertical: space.sm }} />

      <AppText variant="heading" serif>
        From a link
      </AppText>
      <AppText variant="caption" faint>
        Public HTML articles and plain text only. Local and private addresses are blocked.
      </AppText>
      <Field
        value={url}
        onChangeText={setUrl}
        placeholder="https://example.org/essay"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="Article URL"
      />
      <Button
        label="Fetch and import"
        icon="link-outline"
        variant="secondary"
        disabled={!url.trim() || busy}
        onPress={() => void run(() => importArticle(url.trim()))}
      />

      <Divider style={{ marginVertical: space.sm }} />

      <AppText variant="heading" serif>
        Paste text
      </AppText>
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Lecture notes, chapter, essay…" />
      <Field
        label="Text"
        value={text}
        onChangeText={setText}
        placeholder="Paste the material you want to study…"
        multiline
        style={{ minHeight: 140 }}
      />
      <Button
        label="Create document"
        icon="create-outline"
        variant="secondary"
        disabled={!text.trim() || busy}
        onPress={() =>
          void run(async () => {
            const result = await importTextDocument(title.trim() || 'Pasted note', text);
            return { bookId: result.bookId, warnings: result.warnings };
          })
        }
      />

      <View style={{ height: space.xxxl }} />
    </Screen>
  );
}
