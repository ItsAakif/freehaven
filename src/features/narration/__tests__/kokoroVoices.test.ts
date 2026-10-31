import { KOKORO_VOICE_NAMES, kokoroVoiceName } from '@/features/narration/kokoroVoices';

describe('Kokoro voice names', () => {
  it('maps the documented multi-language speaker indices', () => {
    expect(KOKORO_VOICE_NAMES).toHaveLength(28);
    expect(kokoroVoiceName(0)).toBe('af_alloy');
    expect(kokoroVoiceName(2)).toBe('af_bella');
    expect(kokoroVoiceName(6)).toBe('af_nicole');
    expect(kokoroVoiceName(9)).toBe('af_sarah');
    expect(kokoroVoiceName(16)).toBe('am_michael');
    expect(kokoroVoiceName(17)).toBe('am_onyx');
    expect(kokoroVoiceName(27)).toBe('bm_lewis');
  });

  it('falls back to a neutral label above the known range', () => {
    expect(kokoroVoiceName(28)).toBe('Voice 28');
    expect(kokoroVoiceName(102)).toBe('Voice 102');
    expect(kokoroVoiceName(-1)).toBe('Voice -1');
  });
});
