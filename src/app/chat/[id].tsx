import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/design/icon';
import * as Speech from 'expo-speech';
import {
  Screen,
  AppText,
  Card,
  Button,
  Header,
  EmptyState,
  LoadingBlock,
  Chip,
  Sheet,
} from '@/design/ui';
import { radius, space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { getBook } from '@/data/repositories/books';
import { getConversation, listMessages } from '@/data/repositories/mindspace';
import { askBook, saveAnswerAsHighlight } from '@/features/learning/generate';
import { getStoredKey } from '@/ai';
import { getPreset } from '@/ai/presets';
import { usePreferences } from '@/state/preferences';
import type { Citation, Message } from '@/domain/types';

const SUGGESTIONS = [
  'What is the main argument of this book?',
  'Explain the key idea in plain language.',
  'What evidence does the author give?',
  'Give me a concrete example from the text.',
];

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();
  const isConversation = id.startsWith('conv_');
  const scrollRef = useRef<any>(null);
  const [conversationId, setConversationId] = useState<string | null>(isConversation ? id : null);
  const [bookId, setBookId] = useState<string | null>(isConversation ? null : id);
  const [bookTitle, setBookTitle] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const aiProvider = usePreferences((s) => s.aiProvider);
  const aiPreset = usePreferences((s) => s.aiPreset);
  const aiModel = usePreferences((s) => s.aiModel);
  const aiBaseUrl = usePreferences((s) => s.aiBaseUrl);
  const aiKeyPresent = usePreferences((s) => s.aiKeyPresent);
  const [keyStored, setKeyStored] = useState(aiKeyPresent);
  const preset = getPreset(aiPreset);

  useEffect(() => {
    let active = true;
    void getStoredKey()
      .then((key) => {
        if (active) setKeyStored(!!key);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [aiKeyPresent, aiProvider, aiPreset]);

  const remoteConfigured =
    aiProvider === 'openai-compatible' &&
    !!aiBaseUrl.trim() &&
    !!aiModel.trim() &&
    (!preset.requiresKey || keyStored);
  const badgeLabel = remoteConfigured
    ? `${preset.label} · ${aiModel.trim() || preset.defaultModel}`
    : 'On-device';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let activeBookId = bookId;
      if (isConversation) {
        const conversation = await getConversation(id);
        activeBookId = conversation?.bookId ?? null;
        setBookId(activeBookId);
        setBookTitle(conversation?.title ?? 'Conversation');
        setMessages(await listMessages(id));
      } else if (conversationId) {
        setMessages(await listMessages(conversationId));
      }
      if (activeBookId) {
        const book = await getBook(activeBookId);
        setBookTitle(book?.title ?? '');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bookId, conversationId, id, isConversation]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
    return () => clearTimeout(timer);
  }, [messages.length, busy]);

  const send = async (text?: string) => {
    const value = (text ?? question).trim();
    if (!value || !bookId || busy) return;
    setQuestion('');
    setBusy(true);
    setError(null);
    try {
      const result = await askBook({ bookId, question: value, conversationId });
      setConversationId(result.conversationId);
      setMessages(await listMessages(result.conversationId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Header title="Ask" onBack={() => router.back()} />
        <LoadingBlock label="Gathering passages…" />
      </Screen>
    );
  }

  if (!bookId) {
    return (
      <Screen>
        <Header title="Ask" onBack={() => router.back()} />
        <EmptyState icon="chatbubble-outline" title="Nothing to ask about" body="Open a book with extracted text first." />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen scroll={false}>
        <Header
          title="Ask this book"
          subtitle={bookTitle}
          onBack={() => router.back()}
          right={<IconButtonLike label="New conversation" onPress={() => { setConversationId(null); setMessages([]); }} />}
        />

        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <Chip
            label={badgeLabel}
            icon={remoteConfigured ? 'cloud-outline' : 'phone-portrait-outline'}
            active
          />
          <AppText variant="caption" faint style={{ flex: 1 }} numberOfLines={1}>
            {badgeLabel === 'On-device'
              ? 'Answers are extracted from this book, with citations you can check.'
              : 'Answers come from your chosen provider, grounded in this book.'}
          </AppText>
        </View>

        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ gap: space.md, paddingVertical: space.md }} showsVerticalScrollIndicator={false}>
          {messages.length === 0 ? (
            <View style={{ gap: space.sm }}>
              <AppText variant="bodySm" muted>
                Answers are grounded in this book’s indexed passages. Every claim comes with a citation you can check.
              </AppText>
              {SUGGESTIONS.map((suggestion) => (
                <Card key={suggestion} onPress={() => void send(suggestion)} style={{ paddingVertical: space.md }}>
                  <AppText variant="bodySm">{suggestion}</AppText>
                </Card>
              ))}
            </View>
          ) : null}

          {messages.map((message) => (
            <View
              key={message.id}
              style={{
                alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '92%',
                backgroundColor: message.role === 'user' ? palette.accent : palette.surface,
                borderRadius: radius.lg,
                borderWidth: message.role === 'user' ? 0 : 1,
                borderColor: palette.line,
                padding: space.md,
                gap: 6,
              }}
            >
              <AppText variant="bodySm" color={message.role === 'user' ? palette.accentInk : palette.ink} selectable={message.role === 'assistant'}>
                {message.content}
              </AppText>
              {message.citations?.length ? (
                <View style={{ gap: 4, marginTop: 4 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {message.citations.map((c, i) => (
                      <Pressable
                        key={`${c.chunkId}-${i}`}
                        onPress={() => setCitation(c)}
                        accessibilityRole="button"
                        accessibilityLabel={`Citation ${i + 1}`}
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          borderRadius: radius.pill,
                          backgroundColor: palette.accentSoft,
                        }}
                      >
                        <AppText variant="caption" color={palette.accent} style={{ fontWeight: '700' }}>
                          {c.page ? `p. ${c.page}` : `source ${i + 1}`}
                        </AppText>
                      </Pressable>
                    ))}
                  </View>
                  {message.role === 'assistant' ? (
                    <View style={{ flexDirection: 'row', gap: space.md, marginTop: 2 }}>
                      <Pressable
                        onPress={() =>
                          void (async () => {
                            if (!bookId) return;
                            await saveAnswerAsHighlight(bookId, message.citations![0].quote, 'Saved from conversation');
                            setSavedId(message.id);
                          })()
                        }
                        accessibilityRole="button"
                        accessibilityLabel="Save this passage to Mindspace"
                      >
                        <AppText variant="caption" color={palette.accent}>
                          {savedId === message.id ? 'Saved to Mindspace ✓' : 'Save passage'}
                        </AppText>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          if (speakingId === message.id) {
                            void Speech.stop();
                            setSpeakingId(null);
                            return;
                          }
                          void Speech.stop();
                          setSpeakingId(message.id);
                          Speech.speak(message.content.replace(/[#*_`>]/g, ' '), {
                            rate: 1,
                            language: usePreferences.getState().narrationLanguage,
                            onDone: () => setSpeakingId(null),
                            onError: () => setSpeakingId(null),
                          });
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={speakingId === message.id ? 'Stop reading the answer' : 'Read the answer aloud'}
                      >
                        <AppText variant="caption" color={palette.accent}>
                          {speakingId === message.id ? 'Stop reading' : 'Read aloud'}
                        </AppText>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          ))}

          {busy ? (
            <Card style={{ alignSelf: 'flex-start', paddingVertical: space.md }}>
              <AppText variant="caption" muted>
                Reading the passages…
              </AppText>
            </Card>
          ) : null}
        </ScrollView>

        {error ? (
          <AppText variant="caption" color={palette.danger} style={{ marginBottom: space.sm }}>
            {error}
          </AppText>
        ) : null}

        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end', paddingBottom: space.md }}>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder="Ask about this book…"
            placeholderTextColor={palette.inkFaint}
            accessibilityLabel="Your question"
            multiline
            style={{
              flex: 1,
              maxHeight: 110,
              minHeight: 46,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: palette.line,
              backgroundColor: palette.surface,
              color: palette.ink,
              paddingHorizontal: space.md,
              paddingVertical: space.md,
            }}
          />
          <Pressable
            onPress={() => void send()}
            disabled={!question.trim() || busy}
            accessibilityRole="button"
            accessibilityLabel="Send question"
            style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              backgroundColor: palette.accent,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !question.trim() || busy ? 0.5 : 1,
            }}
          >
            <Icon name="arrow-up" size={20} color={palette.accentInk} />
          </Pressable>
        </View>
      </Screen>

      <Sheet visible={!!citation} onClose={() => setCitation(null)} title="Source passage">
        <Card style={{ backgroundColor: palette.surfaceAlt, borderColor: palette.line }}>
          <AppText variant="body" serif>
            “{citation?.quote}”
          </AppText>
        </Card>
        <AppText variant="caption" faint>
          {citation?.page ? `Page ${citation.page}` : 'From an indexed passage'} · chunk {citation?.chunkId.slice(0, 10)}
        </AppText>
        <Button
          label="Open in reader"
          variant="secondary"
          onPress={() => {
            if (!citation) return;
            setCitation(null);
            router.push({ pathname: '/read/[id]', params: { id: bookId, locator: JSON.stringify({ sectionId: '', para: 0, start: 0, end: 0, quote: citation.quote.slice(0, 60) }) } });
          }}
        />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

function IconButtonLike({ label, onPress }: { label: string; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={10} style={{ padding: 8 }}>
      <Icon name="create-outline" size={20} color={palette.ink} />
    </Pressable>
  );
}
