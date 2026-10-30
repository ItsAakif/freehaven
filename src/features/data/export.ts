import { Directory, File, Paths } from 'expo-file-system';
import { db } from '@/data/db';
import { CACHE_DIRS } from './paths';

export { clearCaches } from './paths';

const TABLES = [
  'books',
  'documents',
  'sections',
  'chunks',
  'highlights',
  'bookmarks',
  'bookmark_folders',
  'reading_positions',
  'summaries',
  'summary_sources',
  'cards',
  'reviews',
  'plans',
  'plan_items',
  'conversations',
  'messages',
  'user_profile',
  'activity_events',
  'audio_queue',
  'renditions',
  'rendition_segments',
  'rendition_progress',
] as const;

/** Full personal-data export as JSON (no credentials, no model keys). */
export async function exportUserData(): Promise<{ uri: string; bytes: number }> {
  const payload: Record<string, unknown> = {
    app: 'Freehaven',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
  };
  for (const table of TABLES) {
    try {
      payload[table] = await db().all(`SELECT * FROM ${table}`);
    } catch {
      payload[table] = [];
    }
  }
  const json = JSON.stringify(payload, null, 2);
  const file = new File(Paths.cache, `freehaven-export-${new Date().toISOString().slice(0, 10)}.json`);
  if (file.exists) file.delete();
  file.create();
  await file.write(json);
  return { uri: file.uri, bytes: json.length };
}

export async function storageUsage(): Promise<{
  libraryBytes: number;
  cacheBytes: number;
  narrationBytes: number;
  modelBytes: number;
}> {
  const size = (dir: Directory) => {
    if (!dir.exists) return 0;
    try {
      return dir.size ?? 0;
    } catch {
      return 0;
    }
  };
  const cacheBytes = CACHE_DIRS.reduce(
    (total, name) => total + size(new Directory(Paths.cache, name)),
    0,
  );
  return {
    libraryBytes: size(new Directory(Paths.document, 'library')),
    cacheBytes,
    narrationBytes: size(new Directory(Paths.document, 'renditions')),
    modelBytes: size(new Directory(Paths.document, 'models')),
  };
}

export function formatBytes(bytes: number): string {  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
