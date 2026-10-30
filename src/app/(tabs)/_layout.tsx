import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Icon, type IconName } from '@/design/icon';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';



const TABS: { name: string; href: string; label: string; icon: IconName; activeIcon: IconName }[] = [
  { name: 'index', href: '/', label: 'Today', icon: 'sunny-outline', activeIcon: 'sunny' },
  { name: 'discover', href: '/discover', label: 'Discover', icon: 'compass-outline', activeIcon: 'compass' },
  { name: 'browse', href: '/browse', label: 'Browse', icon: 'search-outline', activeIcon: 'search' },
  { name: 'mindspace', href: '/mindspace', label: 'Mindspace', icon: 'sparkles-outline', activeIcon: 'sparkles' },
  { name: 'create', href: '/create', label: 'Create', icon: 'add-circle-outline', activeIcon: 'add-circle' },
];

export default function TabsLayout() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: palette.bg } }}
      tabBar={({ state }) => (
        <View
          style={[
            styles.bar,
            {
              backgroundColor: palette.bgElevated,
              borderTopColor: palette.line,
              paddingBottom: Math.max(insets.bottom, space.sm),
            },
          ]}
          accessibilityRole="tablist"
        >
          {TABS.map((tab, index) => {
            const focused = state.index === index;
            return (
              <Pressable
                key={tab.name}
                accessibilityRole="tab"
                accessibilityLabel={tab.label}
                accessibilityState={{ selected: focused }}
                onPress={() => router.navigate(tab.href as never)}
                style={({ pressed }) => [
                  styles.item,
                  focused && { backgroundColor: palette.accentSoft },
                  pressed && { opacity: 0.82 },
                ]}
              >
                <Icon
                  name={focused ? tab.activeIcon : tab.icon}
                  size={21}
                  color={focused ? palette.accent : palette.inkMuted}
                />
                <Text
                  style={{
                    fontSize: 10.5,
                    fontWeight: focused ? '700' : '500',
                    color: focused ? palette.accent : palette.inkMuted,
                    letterSpacing: 0.2,
                  }}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    >
      <Tabs.Screen name="index" options={{ title: 'Today' }} />
      <Tabs.Screen name="discover" options={{ title: 'Discover' }} />
      <Tabs.Screen name="browse" options={{ title: 'Browse' }} />
      <Tabs.Screen name="mindspace" options={{ title: 'Mindspace' }} />
      <Tabs.Screen name="create" options={{ title: 'Create' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.sm,
    paddingHorizontal: space.sm,
    gap: 4,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 7,
    minHeight: 54,
    borderRadius: radius.lg,
  },
});
