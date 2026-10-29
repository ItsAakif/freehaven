import React from 'react';
import { View } from 'react-native';
import { AppText } from './ui';
import { space } from './tokens';

/** Minimal Markdown renderer for model/extractive output (headings, lists, emphasis). */
export function Markdown({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <View style={{ gap: space.sm }}>
      {lines.map((line, index) => {
        const key = `${index}-${line.slice(0, 12)}`;
        const trimmed = line.trim();
        if (!trimmed) return <View key={key} style={{ height: 2 }} />;
        if (trimmed.startsWith('### ')) {
          return (
            <AppText key={key} variant="subheading" serif style={{ marginTop: space.sm }}>
              {inline(trimmed.slice(4))}
            </AppText>
          );
        }
        if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
          return (
            <AppText key={key} variant="heading" serif style={{ marginTop: space.sm }}>
              {inline(trimmed.replace(/^#+\s/, ''))}
            </AppText>
          );
        }
        if (/^[-*]\s/.test(trimmed)) {
          return (
            <View key={key} style={{ flexDirection: 'row', gap: space.sm, paddingLeft: 2 }}>
              <AppText variant="body" muted>
                •
              </AppText>
              <AppText variant="body" style={{ flex: 1 }}>
                {inline(trimmed.replace(/^[-*]\s/, ''))}
              </AppText>
            </View>
          );
        }
        if (/^\d+\.\s/.test(trimmed)) {
          const [num, ...rest] = trimmed.split(' ');
          return (
            <View key={key} style={{ flexDirection: 'row', gap: space.sm }}>
              <AppText variant="body" muted>
                {num}
              </AppText>
              <AppText variant="body" style={{ flex: 1 }}>
                {inline(rest.join(' '))}
              </AppText>
            </View>
          );
        }
        if (trimmed.startsWith('> ')) {
          return (
            <View key={key} style={{ borderLeftWidth: 2, borderLeftColor: '#C08A3E', paddingLeft: space.md }}>
              <AppText variant="body" style={{ fontStyle: 'italic' }}>
                {inline(trimmed.slice(2))}
              </AppText>
            </View>
          );
        }
        return (
          <AppText key={key} variant="body">
            {inline(trimmed)}
          </AppText>
        );
      })}
    </View>
  );
}

/** Render **bold**, *italic* and `code` as nested Text spans. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <AppText key={i} variant="body" style={{ fontWeight: '700' }}>
          {part.slice(2, -2)}
        </AppText>
      );
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return (
        <AppText key={i} variant="body" style={{ fontStyle: 'italic' }}>
          {part.slice(1, -1)}
        </AppText>
      );
    }
    return <AppText key={i} variant="body">{part}</AppText>;
  });
}
