/**
 * Completion notification.
 *
 * One immediate local notification when generation finishes while JS is alive.
 * There is no progress notification: expo-notifications cannot update a tray
 * entry while the app is suspended (that needs a foreground service on Android
 * and is unavailable on iOS).
 */

import type { JobRecord } from '@/domain/jobs';
import { usePreferences } from '@/state/preferences';

type NotificationsModule = {
  getPermissionsAsync?: () => Promise<{ granted?: boolean } | null>;
  requestPermissionsAsync: () => Promise<{ granted?: boolean } | null>;
  scheduleNotificationAsync: (input: {
    content: { title: string; body: string };
    trigger: null;
  }) => Promise<unknown>;
};

export async function notifyGenerationFinished(input: {
  job: JobRecord;
  bookTitle: string;
}): Promise<void> {
  try {
    if (!usePreferences.getState().generationNotifications) return;
    if (input.job.status !== 'done') return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Notifications = require('expo-notifications') as NotificationsModule;

    let granted = false;
    if (typeof Notifications.getPermissionsAsync === 'function') {
      const current = await Notifications.getPermissionsAsync();
      granted = !!current?.granted;
    }
    if (!granted) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = !!asked?.granted;
    }
    if (!granted) return;

    await Notifications.scheduleNotificationAsync({
      content: { title: 'Narration ready', body: input.bookTitle },
      trigger: null,
    });
  } catch {
    /* notifications are best-effort and must never fail a finished job */
  }
}
