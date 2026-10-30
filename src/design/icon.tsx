import React from 'react';
import type { ComponentProps } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  Activity,
  ArrowRight,
  ArrowUp,
  Book,
  Bookmark,
  BookStack,
  ChatBubble,
  ChatLines,
  Check,
  Circle,
  Cloud,
  CloudDownload,
  CloudUpload,
  Compass,
  DoubleCheck,
  Download,
  EditPencil,
  Folder,
  HalfMoon,
  Headset,
  Leaf,
  Link,
  List,
  MagicWand,
  Map,
  Microphone,
  MultiBubble,
  MultiplePages,
  NavArrowLeft,
  NavArrowRight,
  Notes,
  OpenBook,
  OpenNewWindow,
  Page,
  Pause,
  Play,
  Plus,
  PlusCircle,
  Refresh,
  RefreshDouble,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Shuffle,
  SkipNext,
  SkipPrev,
  SmartphoneDevice,
  SoundHigh,
  Spark,
  Sparks,
  SunLight,
  Text,
  Trash,
  WarningCircle,
  Xmark,
} from 'iconoir-react-native';

/**
 * One icon surface for the whole app.
 *
 * Call sites keep the semantic Ionicons-style names they always used; this map
 * is the single place that decides which Iconoir (MIT) glyph draws them, so a
 * future icon swap stays a one-file change.
 */
type IconoirIcon = React.ComponentType<ComponentProps<typeof Spark>>;

const MAP: Record<string, IconoirIcon> = {
  add: Plus,
  'add-circle': PlusCircle,
  'add-circle-outline': PlusCircle,
  albums: MultiplePages,
  'albums-outline': MultiplePages,
  'alert-circle-outline': WarningCircle,
  'arrow-forward': ArrowRight,
  'arrow-up': ArrowUp,
  'book-outline': Book,
  bookmark: Bookmark,
  'bookmark-outline': Bookmark,
  'chatbubble-ellipses-outline': ChatLines,
  'chatbubble-outline': ChatBubble,
  'chatbubbles-outline': MultiBubble,
  checkmark: Check,
  'checkmark-circle': Check,
  'checkmark-done': DoubleCheck,
  'checkmark-done-outline': DoubleCheck,
  'chevron-back': NavArrowLeft,
  'chevron-forward': NavArrowRight,
  close: Xmark,
  'cloud-download-outline': CloudDownload,
  'cloud-outline': Cloud,
  'cloud-upload-outline': CloudUpload,
  'color-wand-outline': MagicWand,
  compass: Compass,
  'compass-outline': Compass,
  'create-outline': EditPencil,
  'document-outline': Page,
  'document-text-outline': Notes,
  'download-outline': Download,
  ellipse: Circle,
  'ellipse-outline': Circle,
  'folder-open-outline': Folder,
  headset: Headset,
  'headset-outline': Headset,
  'leaf-outline': Leaf,
  'library-outline': BookStack,
  'link-outline': Link,
  list: List,
  'list-outline': List,
  'map-outline': Map,
  'mic-outline': Microphone,
  'moon-outline': HalfMoon,
  'open-outline': OpenNewWindow,
  pause: Pause,
  'phone-portrait-outline': SmartphoneDevice,
  play: Play,
  'play-skip-back': SkipPrev,
  'play-skip-forward': SkipNext,
  'pulse-outline': Activity,
  'reader-outline': OpenBook,
  'refresh-outline': Refresh,
  search: Search,
  'search-outline': Search,
  'server-outline': Server,
  'settings-outline': Settings,
  'shield-checkmark-outline': ShieldCheck,
  'shuffle-outline': Shuffle,
  sparkles: Sparks,
  'sparkles-outline': Spark,
  sunny: SunLight,
  'sunny-outline': SunLight,
  'sync-outline': RefreshDouble,
  text: Text,
  'trash-outline': Trash,
  'volume-high': SoundHigh,
};

export type IconName = keyof typeof MAP | (string & {});

export function Icon({
  name,
  size = 20,
  color = '#111111',
  strokeWidth = 1.65,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const Component = MAP[name] ?? Spark;
  return (
    <Component
      width={size}
      height={size}
      color={color}
      strokeWidth={strokeWidth}
      style={style}
    />
  );
}
