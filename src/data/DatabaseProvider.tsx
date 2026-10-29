import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { initDatabase, db } from './db';
import { useTheme } from '@/design/theme';

type Status = 'loading' | 'ready' | 'error';

const DatabaseContext = createContext<{ status: Status; retry: () => void }>({
  status: 'loading',
  retry: () => {},
});

export function DatabaseProvider({ children }: { children: React.ReactNode }) {
  const { palette } = useTheme();
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => {
    setStatus('loading');
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initDatabase();
        if (!cancelled) setStatus('ready');
      } catch (error) {
        if (!cancelled) {
          setMessage((error as Error).message);
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  if (status === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: palette.bg }]}>
        <ActivityIndicator color={palette.accent} />
        <Text style={{ color: palette.inkMuted, marginTop: 12 }}>Opening your library…</Text>
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: palette.bg, padding: 32 }]}>
        <Text style={{ color: palette.ink, fontSize: 20, textAlign: 'center', marginBottom: 8 }}>
          Freehaven could not open its database
        </Text>
        <Text style={{ color: palette.inkMuted, textAlign: 'center', marginBottom: 20 }}>{message}</Text>
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel="Retry opening the database"
          style={{ backgroundColor: palette.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999 }}
        >
          <Text style={{ color: palette.accentInk, fontWeight: '600' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return <DatabaseContext.Provider value={{ status, retry }}>{children}</DatabaseContext.Provider>;
}

export function useDatabase() {
  const ctx = useContext(DatabaseContext);
  if (ctx.status !== 'ready') throw new Error('Database is not ready.');
  return db();
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
