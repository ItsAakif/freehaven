import {
  DEFAULT_STYLE_ID,
  LEGACY_STYLE_MAP,
  NARRATION_STYLES,
  coerceNarrationStyle,
  getNarrationStyle,
} from '@/features/narration/styles';

describe('narration styles', () => {
  it('has exactly seven unique presets', () => {
    expect(NARRATION_STYLES).toHaveLength(7);
    const ids = NARRATION_STYLES.map((style) => style.id);
    expect(new Set(ids).size).toBe(7);
    for (const legacy of ['calm', 'conversational', 'teacher', 'dramatic']) {
      expect(ids).not.toContain(legacy);
    }
  });

  it('fills every required field', () => {
    for (const style of NARRATION_STYLES) {
      expect(style.label.trim()).not.toBe('');
      expect(style.persona.trim()).not.toBe('');
      expect(style.directive.trim()).not.toBe('');
      expect(style.scriptRules.length).toBeGreaterThanOrEqual(2);
      expect(['5', '15', '25']).toContain(style.defaultLength);
      expect(style.fillerBudget).toBeGreaterThanOrEqual(0);
      expect(style.fillerBudget).toBeLessThanOrEqual(1);
      for (const engine of ['device', 'remote', 'piper', 'kokoro'] as const) {
        const voice = style.defaultVoices[engine];
        expect(voice === null || (typeof voice === 'string' && voice.length > 0)).toBe(true);
      }
      expect(style.defaultVoices.device).toBeNull();
      expect(style.kokoroSpeakerId).toBeGreaterThanOrEqual(0);
      expect(style.kokoroSpeakerId).toBeLessThanOrEqual(102);
    }
  });

  it('gives every style a distinct directive', () => {
    const directives = NARRATION_STYLES.map((style) => style.directive);
    expect(new Set(directives).size).toBe(7);
  });

  it('coerces every legacy id', () => {
    expect(coerceNarrationStyle('calm')).toBe('fireside');
    expect(coerceNarrationStyle('conversational')).toBe('fireside');
    expect(coerceNarrationStyle('teacher')).toBe('plain');
    expect(coerceNarrationStyle('dramatic')).toBe('chronicle');
    expect(coerceNarrationStyle('neutral')).toBe('fireside');
    expect(coerceNarrationStyle('summary')).toBe('brief');
  });

  it('falls back to fireside for garbage and nulls', () => {
    expect(coerceNarrationStyle(undefined)).toBe('fireside');
    expect(coerceNarrationStyle(null)).toBe('fireside');
    expect(coerceNarrationStyle('')).toBe('fireside');
    expect(coerceNarrationStyle(42)).toBe('fireside');
    expect(coerceNarrationStyle('not-a-style')).toBe('fireside');
    expect(coerceNarrationStyle('Fireside')).toBe('fireside');
  });

  it('looks styles up defensively', () => {
    expect(getNarrationStyle(undefined).id).toBe('fireside');
    expect(getNarrationStyle(null).id).toBe('fireside');
    expect(getNarrationStyle('nope').id).toBe('fireside');
    expect(getNarrationStyle('teacher').id).toBe('plain');
    expect(getNarrationStyle('Brief').id).toBe('brief');
    expect(DEFAULT_STYLE_ID).toBe('fireside');
  });

  it('keeps the legacy map aligned with real ids', () => {
    const ids = new Set(NARRATION_STYLES.map((style) => style.id));
    for (const mapped of Object.values(LEGACY_STYLE_MAP)) expect(ids.has(mapped)).toBe(true);
  });
});
