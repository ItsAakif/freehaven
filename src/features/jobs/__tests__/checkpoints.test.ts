/** @jest-environment node */
import {
  scriptStageKey,
  synthStageKey,
  unitInputKey,
} from '@/features/jobs/checkpoints';

const scriptInput = {
  bookId: 'b',
  documentId: 'd',
  styleId: 'fireside',
  length: '15' as const,
  instructionHash: 'abcd1234',
  planVersion: 1,
  providerId: 'fake',
  model: null,
};

const synthInput = {
  renditionId: 'r',
  engine: 'remote' as const,
  voice: 'alloy',
  model: 'tts-1',
  instructionHash: 'abcd1234',
  segmentPlanVersion: 1,
};

describe('checkpoint keys', () => {
  it('is stable for identical script inputs and changes with provider or model', () => {
    expect(scriptStageKey(scriptInput)).toBe(scriptStageKey(scriptInput));
    expect(scriptStageKey({ ...scriptInput, providerId: 'other' })).not.toBe(
      scriptStageKey(scriptInput),
    );
    expect(scriptStageKey({ ...scriptInput, model: 'm' })).not.toBe(
      scriptStageKey(scriptInput),
    );
    expect(scriptStageKey({ ...scriptInput, instructionHash: 'ffffffff' })).not.toBe(
      scriptStageKey(scriptInput),
    );
  });

  it('keeps script keys independent of engine and voice', () => {
    const engineOnly = scriptStageKey(scriptInput);
    expect(engineOnly).toBe(scriptStageKey(scriptInput));
  });

  it('changes synth keys with engine, voice or instruction', () => {
    expect(synthStageKey(synthInput)).toBe(synthStageKey(synthInput));
    expect(synthStageKey({ ...synthInput, engine: 'kokoro' })).not.toBe(
      synthStageKey(synthInput),
    );
    expect(synthStageKey({ ...synthInput, voice: 'nova' })).not.toBe(
      synthStageKey(synthInput),
    );
    expect(synthStageKey({ ...synthInput, instructionHash: 'ffffffff' })).not.toBe(
      synthStageKey(synthInput),
    );
  });

  it('scopes unit keys by stage, ordinal and input', () => {
    const stageKey = scriptStageKey(scriptInput);
    expect(unitInputKey(stageKey, 'map', 0, 'text')).toBe(unitInputKey(stageKey, 'map', 0, 'text'));
    expect(unitInputKey(stageKey, 'map', 1, 'text')).not.toBe(
      unitInputKey(stageKey, 'map', 0, 'text'),
    );
    expect(unitInputKey(stageKey, 'reduce', 0, 'text')).not.toBe(
      unitInputKey(stageKey, 'map', 0, 'text'),
    );
    expect(unitInputKey(stageKey, 'map', 0, 'other')).not.toBe(
      unitInputKey(stageKey, 'map', 0, 'text'),
    );
    expect(unitInputKey(stageKey, 'map', 0, 'text')).toMatch(/^[0-9a-f]{8}$/);
  });
});
