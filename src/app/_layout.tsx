import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { ThemeProvider, useTheme } from '@/design/theme';
import { DatabaseProvider } from '@/data/DatabaseProvider';
import { usePreferences } from '@/state/preferences';

void SplashScreen.preventAutoHideAsync().catch(() => {});

function HideSplashWhenReady() {
  const hydrated = usePreferences((s) => s.hydrated);
  const { palette, isDark } = useTheme();

  useEffect(() => {
    // Never leave the splash up if preference hydration stalls.
    const fallback = setTimeout(() => {
      void SplashScreen.hideAsync().catch(() => {});
    }, 1800);
    return () => clearTimeout(fallback);
  }, []);

  useEffect(() => {
    if (hydrated) {
      const timer = setTimeout(() => {
        void SplashScreen.hideAsync().catch(() => {});
      }, 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [hydrated]);

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
        <Stack.Screen name="review" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="import" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="settings" />
        <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        <Stack.Screen name="plan/[id]" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <DatabaseProvider>
            <HideSplashWhenReady />
          </DatabaseProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
