// Jest environment shims. Native modules are replaced with inert doubles so
// pure logic and SQLite repositories can be tested without a device.

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('expo-sqlite is not available in unit tests; inject the test driver.');
  }),
}));

jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-file-system', () => {
  class FakeFile {
    uri: string;
    size = 0;
    name = 'file';
    exists = false;
    constructor(..._args: unknown[]) {
      this.uri = 'file:///fake';
    }
  }
  class FakeDirectory {
    uri = 'file:///fake-dir';
    exists = false;
    size = 0;
    create() {}
  }
  return {
    File: FakeFile,
    Directory: FakeDirectory,
    Paths: { document: {}, cache: {}, bundle: {} },
  };
});

jest.mock('expo-notifications', () => ({
  requestPermissionsAsync: jest.fn(async () => ({ granted: false })),
  cancelAllScheduledNotificationsAsync: jest.fn(async () => undefined),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  SchedulableTriggerInputTypes: { DAILY: 'daily' },
}));

process.env.TZ = 'UTC';
