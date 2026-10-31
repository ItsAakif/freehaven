import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { ThemeProvider, useTheme } from '@/design/theme';
import { palettes, radius, space, type } from '@/design/tokens';
import { DatabaseProvider } from '@/data/DatabaseProvider';
import { usePreferences } from '@/state/preferences';
import { installGlobalErrorHandler } from '@/lib/crashLog';
import { resolveStartupView, type DatabaseStartupStatus } from '@/lib/startup';

void SplashScreen.preventAutoHideAsync().catch(() => {});

installGlobalErrorHandler();

function SplashGate({ database }: { database: DatabaseStartupStatus }) {
  const hydrated = usePreferences((s) => s.hydrated);
  const [fallbackElapsed, setFallbackElapsed] = useState(false);

  useEffect(() => {
    // Never leave the splash up if preference hydration or the database stalls.
    const fallback = setTimeout(() => setFallbackElapsed(true), 1800);
    return () => clearTimeout(fallback);
  }, []);

  const view = resolveStartupView({
    database,
    hydrated,
    splashHidden: fallbackElapsed,
  });

  useEffect(() => {
    if (view === 'splash') return undefined;
    const timer = setTimeout(() => {
      void SplashScreen.hideAsync().catch(() => {});
    }, 80);
    return () => clearTimeout(timer);
  }, [view]);

  return null;
}

function AppNavigator() {
  const { palette, isDark } = useTheme();

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: palette.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="book/[id]" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="read/[id]" options={{ animation: 'fade' }} />
        <Stack.Screen name="summary/[id]" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="listen/[id]" />
        <Stack.Screen name="guide/[id]" />
        <Stack.Screen name="generate/[renditionId]" />
        <Stack.Screen name="library" />
        <Stack.Screen name="review" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="import" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="settings" />
        <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        <Stack.Screen name="plan/[id]" />
      </Stack>
    </>
  );
}

function StartupShell() {
  const [database, setDatabase] = useState<DatabaseStartupStatus>('loading');

  return (
    <>
      <SplashGate database={database} />
      <DatabaseProvider onStatusChange={setDatabase}>
        <AppNavigator />
      </DatabaseProvider>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <StartupShell />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Expo Router route-level error boundary. It deliberately does not use the
 * theme context: an error inside ThemeProvider itself must still render.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const message = error?.message || 'Unknown error';
  const stack = error?.stack || '(no stack trace)';

  return (
    <View style={errorStyles.screen}>
      <Text style={errorStyles.title}>Freehaven could not start</Text>
      <Text style={errorStyles.body}>
        Something broke before the first screen was ready. The details below can help diagnose it.
      </Text>
      <ScrollView style={errorStyles.details} contentContainerStyle={errorStyles.detailsContent}>
        <Text selectable style={errorStyles.message}>
          {message}
        </Text>
        <Text selectable style={errorStyles.stack}>
          {stack}
        </Text>
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Retry starting Freehaven"
        onPress={() => {
          void retry().catch(() => {});
        }}
        style={({ pressed }) => [errorStyles.button, pressed && errorStyles.buttonPressed]}
      >
        <Text style={errorStyles.buttonText}>Retry</Text>
      </Pressable>
    </View>
  );
}

const paper = palettes.light;

const errorStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: paper.bg,
    paddingHorizontal: space.xxl,
    paddingTop: space.huge,
    paddingBottom: space.xxl,
  },
  title: {
    color: paper.ink,
    fontSize: type.title.fontSize,
    lineHeight: type.title.lineHeight,
    fontWeight: '700',
    marginBottom: space.sm,
  },
  body: {
    color: paper.inkMuted,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
    marginBottom: space.lg,
  },
  details: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: paper.line,
    backgroundColor: paper.surface,
  },
  detailsContent: {
    padding: space.lg,
  },
  message: {
    color: paper.danger,
    fontSize: type.bodySm.fontSize,
    lineHeight: type.bodySm.lineHeight,
    fontWeight: '600',
    marginBottom: space.md,
  },
  stack: {
    color: paper.inkMuted,
    fontSize: type.caption.fontSize,
    lineHeight: type.caption.lineHeight,
  },
  button: {
    marginTop: space.lg,
    backgroundColor: paper.accent,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonText: {
    color: paper.accentInk,
    fontSize: type.bodySm.fontSize,
    fontWeight: '600',
  },
});
