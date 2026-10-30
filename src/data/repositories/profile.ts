import { db } from '@/data/db';
import { newId } from '@/lib/id';

export type Familiarity = 'new' | 'some' | 'confident';

export type Profile = {
  displayName: string | null;
  goal: string | null;
  topics: string[];
  familiarity: Record<string, Familiarity>;
  minutesPerDay: number;
  onboardingComplete: boolean;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_PROFILE: Profile = {
  displayName: null,
  goal: null,
  topics: [],
  familiarity: {},
  minutesPerDay: 15,
  onboardingComplete: false,
  createdAt: 0,
  updatedAt: 0,
};

type ProfileRow = {
  id: string;
  display_name: string | null;
  goal: string | null;
  topics_json: string | null;
  familiarity_json: string | null;
  minutes_per_day: number;
  onboarding_complete: number;
  created_at: number;
  updated_at: number;
};

export async function getProfile(): Promise<Profile> {
  const row = await db().first<ProfileRow>("SELECT * FROM user_profile WHERE id = 'default'");
  if (!row) return DEFAULT_PROFILE;
  return {
    displayName: row.display_name,
    goal: row.goal,
    topics: safeJson<string[]>(row.topics_json, []),
    familiarity: safeJson<Record<string, Familiarity>>(row.familiarity_json, {}),
    minutesPerDay: row.minutes_per_day || 15,
    onboardingComplete: row.onboarding_complete === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function saveProfile(patch: Partial<Profile>): Promise<Profile> {
  const current = await getProfile();
  const next: Profile = {
    ...current,
    ...patch,
    familiarity: patch.familiarity ?? current.familiarity,
    topics: patch.topics ?? current.topics,
    updatedAt: Date.now(),
    createdAt: current.createdAt || Date.now(),
  };
  await db().run(
    `INSERT INTO user_profile (id, display_name, goal, topics_json, familiarity_json, minutes_per_day, onboarding_complete, created_at, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, goal=excluded.goal,
       topics_json=excluded.topics_json, familiarity_json=excluded.familiarity_json,
       minutes_per_day=excluded.minutes_per_day, onboarding_complete=excluded.onboarding_complete,
       updated_at=excluded.updated_at`,
    [
      next.displayName,
      next.goal,
      JSON.stringify(next.topics),
      JSON.stringify(next.familiarity),
      next.minutesPerDay,
      next.onboardingComplete ? 1 : 0,
      next.createdAt,
      next.updatedAt,
    ],
  );
  return next;
}

export async function completeOnboarding(): Promise<void> {
  await saveProfile({ onboardingComplete: true });
}

/** 1 = new to the topic, 3 = confident. Unknown topics rank in the middle. */
export function familiarityScore(profile: Profile, topic: string | null | undefined): number {
  if (!topic) return 2;
  const value = profile.familiarity[topic.toLowerCase()];
  if (value === 'new') return 1;
  if (value === 'confident') return 3;
  return 2;
}

export function newFolderId(): string {
  return newId('folder');
}
