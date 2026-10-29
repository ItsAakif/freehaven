import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout, radius, space, type as typo } from './tokens';
import { useTheme } from './theme';
import type { Palette } from './tokens';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/* ------------------------------------------------------------------ text */

type TextVariant = keyof typeof typo;

export function AppText({
  variant = 'body',
  serif,
  muted,
  faint,
  color,
  style,
  children,
  ...rest
}: TextProps & {
  variant?: TextVariant;
  serif?: boolean;
  muted?: boolean;
  faint?: boolean;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  const { palette } = useTheme();
  return (
    <Text
      {...rest}
      style={[
        typo[variant],
        {
          color: color ?? (faint ? palette.inkFaint : muted ? palette.inkMuted : palette.ink),
          fontFamily: serif ? serifFamily : sansFamily,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// System faces keep the bundle small and render consistently on both platforms.
export const serifFamily = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' });
export const sansFamily = Platform.select({ ios: undefined, android: 'sans-serif', default: undefined });

/* ---------------------------------------------------------------- screen */

export function Screen({
  children,
  scroll = true,
  padded = true,
  style,
  contentStyle,
  footer,
  edges = ['top'],
}: {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  footer?: React.ReactNode;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
}) {
  const { palette } = useTheme();
  const body = padded ? { paddingHorizontal: layout.screenPadding } : null;
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: palette.bg }, style]}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[{ paddingBottom: space.xxxl, gap: space.lg }, body, contentStyle]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, body, contentStyle]}>{children}</View>
      )}
      {footer}
    </SafeAreaView>
  );
}

export function Header({
  title,
  subtitle,
  right,
  onBack,
  style,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onBack?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ gap: space.xs, paddingTop: space.sm }, style]}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.md,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 }}>
          {onBack ? (
            <IconButton name="chevron-back" label="Go back" onPress={onBack} size={22} />
          ) : null}
          <AppText variant="title" serif style={{ flexShrink: 1 }}>
            {title}
          </AppText>
        </View>
        {right}
      </View>
      {subtitle ? (
        <AppText variant="bodySm" muted>
          {subtitle}
        </AppText>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------- button */

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  full,
  size = 'md',
  accessibilityHint,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'warm' | 'danger';
  icon?: IoniconName;
  loading?: boolean;
  disabled?: boolean;
  full?: boolean;
  size?: 'sm' | 'md' | 'lg';
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  const height = size === 'sm' ? 44 : size === 'lg' ? 54 : 46;
  const bg =
    variant === 'primary'
      ? palette.accent
      : variant === 'warm'
        ? palette.warm
        : variant === 'danger'
          ? palette.dangerSoft
          : variant === 'secondary'
            ? palette.surfaceAlt
            : 'transparent';
  const fg =
    variant === 'primary' || variant === 'warm'
      ? palette.accentInk
      : variant === 'danger'
        ? palette.danger
        : palette.ink;
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      style={({ pressed }) => [
        {
          minHeight: height,
          paddingHorizontal: size === 'sm' ? space.md : space.xl,
          borderRadius: radius.pill,
          backgroundColor: bg,
          borderWidth: variant === 'ghost' ? 1 : 0,
          borderColor: palette.line,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: space.sm,
          opacity: isDisabled ? 0.5 : pressed ? 0.86 : 1,
          alignSelf: full ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : icon ? (
        <Ionicons name={icon} size={18} color={fg} />
      ) : null}
      <Text style={{ color: fg, fontFamily: sansFamily, fontSize: 15, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function IconButton({
  name,
  label,
  onPress,
  size = 20,
  color,
  style,
}: {
  name: IoniconName;
  label: string;
  onPress?: () => void;
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      style={({ pressed }) => [
        {
          width: 44,
          height: 44,
          borderRadius: radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? palette.surfaceAlt : 'transparent',
        },
        style,
      ]}
    >
      <Ionicons name={name} size={size} color={color ?? palette.ink} />
    </Pressable>
  );
}

/* --------------------------------------------------------------- surfaces */

export function Card({
  children,
  onPress,
  style,
  accessibilityLabel,
  accessibilityHint,
  padded = true,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  padded?: boolean;
}) {
  const { palette } = useTheme();
  const content = (
    <View
      style={[
        {
          backgroundColor: palette.surface,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.line,
          padding: padded ? space.lg : 0,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.995 : 1 }] }]}
    >
      {content}
    </Pressable>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { palette } = useTheme();
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: palette.line }, style]} />;
}

export function Chip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  icon?: IoniconName;
}) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radius.pill,
        backgroundColor: active ? palette.accent : palette.surfaceAlt,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: active ? palette.accent : palette.line,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {icon ? <Ionicons name={icon} size={14} color={active ? palette.accentInk : palette.ink} /> : null}
      <Text
        style={{
          color: active ? palette.accentInk : palette.ink,
          fontSize: 13,
          fontWeight: '600',
          fontFamily: sansFamily,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ProgressBar({
  value,
  height = 6,
  color,
  style,
}: {
  value: number;
  height?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[
        { height, borderRadius: height, backgroundColor: palette.surfaceAlt, overflow: 'hidden' },
        style,
      ]}
    >
      <View style={{ width: `${clamped * 100}%`, height, borderRadius: height, backgroundColor: color ?? palette.accent }} />
    </View>
  );
}

export function Cover({
  uri,
  title,
  width = 74,
  height = 108,
  style,
}: {
  uri?: string | null;
  title: string;
  width?: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  const [failed, setFailed] = React.useState(false);
  return (
    <View
      style={[
        {
          width,
          height,
          borderRadius: radius.sm,
          backgroundColor: palette.surfaceAlt,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.line,
        },
        style,
      ]}
    >
      {uri && !failed ? (
        <Image
          source={{ uri }}
          style={{ width, height }}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityLabel={`Cover of ${title}`}
        />
      ) : (
        <AppText variant="caption" muted style={{ paddingHorizontal: 6, textAlign: 'center' }} numberOfLines={3}>
          {title}
        </AppText>
      )}
    </View>
  );
}

/* ----------------------------------------------------------------- states */

export function EmptyState({
  icon = 'leaf-outline',
  title,
  body,
  actionLabel,
  onAction,
}: {
  icon?: IoniconName;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const { palette } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xxxl, gap: space.sm }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.pill,
          backgroundColor: palette.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={24} color={palette.inkMuted} />
      </View>
      <AppText variant="subheading" serif style={{ textAlign: 'center' }}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="bodySm" muted style={{ textAlign: 'center', maxWidth: 300 }}>
          {body}
        </AppText>
      ) : null}
      {actionLabel && onAction ? (
        <View style={{ marginTop: space.sm }}>
          <Button label={actionLabel} onPress={onAction} variant="secondary" size="sm" />
        </View>
      ) : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { palette } = useTheme();
  return (
    <Card style={{ borderColor: palette.dangerSoft, backgroundColor: palette.dangerSoft }}>
      <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
        <Ionicons name="alert-circle-outline" size={20} color={palette.danger} />
        <View style={{ flex: 1, gap: 6 }}>
          <AppText variant="bodySm" color={palette.danger}>
            {message}
          </AppText>
          {onRetry ? (
            <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Try again">
              <AppText variant="label" color={palette.danger} style={{ fontWeight: '700' }}>
                Try again
              </AppText>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  const { palette } = useTheme();
  return (
    <View style={{ paddingVertical: space.xxxl, alignItems: 'center', gap: space.sm }}>
      <ActivityIndicator color={palette.accent} />
      <AppText variant="caption" muted>
        {label}
      </AppText>
    </View>
  );
}

/* ------------------------------------------------------------------- misc */

export function SectionHeader({
  title,
  actionLabel,
  onAction,
  style,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md },
        style,
      ]}
    >
      <AppText variant="heading" serif>
        {title}
      </AppText>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={`${actionLabel} ${title}`} hitSlop={8}>
          <AppText variant="label" muted style={{ fontWeight: '600' }}>
            {actionLabel}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ gap: 2 }}>
      <AppText variant="heading" serif>
        {value}
      </AppText>
      <AppText variant="caption" faint>
        {label}
      </AppText>
    </View>
  );
}

export function Field({
  label,
  hint,
  style,
  multiline,
  ...rest
}: TextInputProps & { label?: string; hint?: string; style?: StyleProp<TextStyle> }) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <AppText variant="label" muted>
          {label}
        </AppText>
      ) : null}
      <TextInput
        {...rest}
        multiline={multiline}
        placeholderTextColor={palette.inkFaint}
        accessibilityLabel={rest.accessibilityLabel ?? label}
        style={[
          {
            backgroundColor: palette.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: palette.line,
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
            color: palette.ink,
            fontFamily: sansFamily,
            fontSize: 15,
            minHeight: multiline ? 110 : 46,
            textAlignVertical: multiline ? 'top' : 'center',
          },
          style,
        ]}
      />
      {hint ? (
        <AppText variant="caption" faint>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: palette.overlay, justifyContent: 'flex-end' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close sheet" />
        <View
          style={{
            backgroundColor: palette.bgElevated,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            padding: space.xl,
            paddingBottom: insets.bottom + space.xl,
            maxHeight: '86%',
            gap: space.md,
          }}
        >
          <View style={{ alignItems: 'center' }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: palette.line }} />
          </View>
          {title ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <AppText variant="heading" serif>
                {title}
              </AppText>
              <IconButton name="close" label="Close" onPress={onClose} size={20} />
            </View>
          ) : null}
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: space.md }}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const [opacity] = useState(() => new Animated.Value(0));
  const [translate] = useState(() => new Animated.Value(8));
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 260, delay, useNativeDriver: true }),
      Animated.timing(translate, { toValue: 0, duration: 260, delay, useNativeDriver: true }),
    ]).start();
  }, [delay, opacity, translate]);
  return (
    <Animated.View style={{ opacity, transform: [{ translateY: translate }] }}>{children}</Animated.View>
  );
}

export const uiStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gapSm: { gap: space.sm },
  gapMd: { gap: space.md },
});

export type IconName = IoniconName;
export type { Palette };
export type { ImageSourcePropType };
