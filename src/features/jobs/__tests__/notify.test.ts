/** @jest-environment node */
import * as Notifications from 'expo-notifications';
import type { JobRecord } from '@/domain/jobs';
import { notifyGenerationFinished } from '@/features/jobs/notify';
import { usePreferences } from '@/state/preferences';

const requestPermissions = Notifications.requestPermissionsAsync as jest.Mock;
const scheduleNotification = Notifications.scheduleNotificationAsync as jest.Mock;

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job1',
    type: 'narration.generate',
    renditionId: 'r1',
    status: 'done',
    stage: 'synth',
    progress: 1,
    unitsDone: 10,
    unitsTotal: 10,
    etaRemainingMs: 0,
    etaLowMs: 0,
    etaHighMs: 0,
    startedAt: 1,
    heartbeatAt: 2,
    finishedAt: 3,
    cancelRequested: false,
    attempts: 1,
    scriptHash: 'a',
    synthHash: 'b',
    error: null,
    createdAt: 1,
    updatedAt: 3,
    ...overrides,
  };
}

describe('notifyGenerationFinished', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestPermissions.mockResolvedValue({ granted: false });
    usePreferences.setState({ generationNotifications: false });
  });

  afterEach(() => {
    usePreferences.setState({ generationNotifications: false });
  });

  it('does nothing when the preference is off', async () => {
    await notifyGenerationFinished({ job: job(), bookTitle: 'A Book' });
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(scheduleNotification).not.toHaveBeenCalled();
  });

  it('does not announce a failed job even when notifications are on', async () => {
    usePreferences.setState({ generationNotifications: true });
    await notifyGenerationFinished({ job: job({ status: 'failed' }), bookTitle: 'A Book' });
    expect(scheduleNotification).not.toHaveBeenCalled();
  });

  it('resolves quietly when permission is denied', async () => {
    usePreferences.setState({ generationNotifications: true });
    await expect(
      notifyGenerationFinished({ job: job(), bookTitle: 'A Book' }),
    ).resolves.toBeUndefined();
    expect(scheduleNotification).not.toHaveBeenCalled();
  });

  it('schedules one immediate notification when granted', async () => {
    usePreferences.setState({ generationNotifications: true });
    requestPermissions.mockResolvedValue({ granted: true });
    await notifyGenerationFinished({ job: job(), bookTitle: 'A Book' });
    expect(scheduleNotification).toHaveBeenCalledWith({
      content: { title: 'Narration ready', body: 'A Book' },
      trigger: null,
    });
  });

  it('never throws when the notification module fails', async () => {
    usePreferences.setState({ generationNotifications: true });
    requestPermissions.mockRejectedValue(new Error('nope'));
    await expect(
      notifyGenerationFinished({ job: job(), bookTitle: 'A Book' }),
    ).resolves.toBeUndefined();
  });
});
