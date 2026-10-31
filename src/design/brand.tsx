import React from 'react';
import type { StyleProp } from 'react-native';
import { Image, type ImageStyle } from 'expo-image';

const MARK = require('../../assets/images/icon.png');
const LOCKUP = require('../../assets/images/brand-lockup.png');

// brand-lockup.png is 942 x 993. Keep its aspect ratio when only a height is given.
const LOCKUP_ASPECT = 942 / 993;

export function BrandMark({
  size = 40,
  style,
}: {
  size?: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      source={MARK}
      style={[{ width: size, height: size }, style]}
      contentFit="contain"
      accessibilityLabel="Freehaven"
    />
  );
}

export function BrandLockup({
  height = 44,
  style,
}: {
  height?: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      source={LOCKUP}
      style={[{ width: height * LOCKUP_ASPECT, height }, style]}
      contentFit="contain"
      accessibilityLabel="Freehaven"
    />
  );
}
