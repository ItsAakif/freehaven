import { migratePreferences } from '@/state/preferencesMigration';

describe('preferences migration', () => {
  it('maps the legacy style ids', () => {
    expect(migratePreferences({ narrationStyle: 'teacher' }, 1).narrationStyle).toBe('plain');
    expect(migratePreferences({ narrationStyle: 'dramatic' }, 1).narrationStyle).toBe('chronicle');
    expect(migratePreferences({ narrationStyle: 'calm' }, 1).narrationStyle).toBe('fireside');
    expect(migratePreferences({ narrationStyle: 'conversational' }, 1).narrationStyle).toBe(
      'fireside',
    );
    expect(migratePreferences({ narrationStyle: 'garbage' }, 1).narrationStyle).toBe('fireside');
    expect(migratePreferences({ narrationStyle: 42 }, 1).narrationStyle).toBe('fireside');
  });

  it('derives the narration engine from studioVoice', () => {
    expect(migratePreferences({ studioVoice: true }, 1).narrationEngine).toBe('remote');
    expect(migratePreferences({ studioVoice: true }, 1).studioVoice).toBe(true);
    expect(migratePreferences({ studioVoice: false }, 1).narrationEngine).toBe('device');
  });

  it('fills the v2 defaults for an empty store', () => {
    const migrated = migratePreferences({}, 1);
    expect(migrated.aiPreset).toBe('openai');
    expect(migrated.narrationStyle).toBe('fireside');
    expect(migrated.narrationEngine).toBe('device');
    expect(migrated.narrationLength).toBe('15');
    expect(migrated.aiResponseFormat).toBe('auto');
    expect(migrated.narrationInstruction).toBe('');
  });

  it('infers the preset from a recognised base URL and falls back to custom', () => {
    expect(
      migratePreferences({ aiBaseUrl: 'https://api.groq.com/openai/v1/' }, 1).aiPreset,
    ).toBe('groq');
    expect(
      migratePreferences({ aiBaseUrl: 'http://192.168.1.10:11434/v1' }, 1).aiPreset,
    ).toBe('ollama');
    expect(
      migratePreferences({ aiBaseUrl: 'https://nonsense.example.com/v1' }, 1).aiPreset,
    ).toBe('custom');
  });

  it('keeps an explicit preset over inference', () => {
    const migrated = migratePreferences(
      { aiPreset: 'mistral', aiBaseUrl: 'https://api.groq.com/openai/v1' },
      1,
    );
    expect(migrated.aiPreset).toBe('mistral');
  });

  it('is idempotent and preserves unknown keys', () => {
    const input = {
      narrationStyle: 'teacher',
      studioVoice: false,
      customThing: { nested: true },
      another: 'kept',
    };
    const once = migratePreferences(input, 1);
    const twice = migratePreferences(once, 2);
    expect(twice).toEqual(once);
    const preserved = once as Record<string, unknown>;
    expect(preserved.customThing).toEqual({ nested: true });
    expect(preserved.another).toBe('kept');
  });

  it('never throws on hostile input', () => {
    for (const value of [null, undefined, 'text', 42, [], ['x']]) {
      expect(() => migratePreferences(value, 1)).not.toThrow();
      expect(migratePreferences(value, 1).narrationStyle).toBe('fireside');
    }
  });
});
