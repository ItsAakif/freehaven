import { NARRATION_STYLES, getNarrationStyle } from '@/features/narration/styles';
import {
  composeScriptSystemPrompt,
  composeScriptUserPrompt,
  instructionHash,
  sanitiseInstruction,
} from '@/features/narration/script';

describe('script prompts', () => {
  it('sanitises instructions deterministically', () => {
    expect(sanitiseInstruction('  ')).toBe('');
    expect(sanitiseInstruction('line one\nline two')).toBe('line one line two');
    expect(sanitiseInstruction('```js\nhello\n```')).toBe('js hello');
    expect(sanitiseInstruction('keep {this} [out]')).toBe('keep this out');
    const long = sanitiseInstruction('word '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(280);
    expect(long.length).toBeGreaterThan(0);
  });

  it('hashes only non-empty instructions', () => {
    expect(instructionHash('')).toBe('');
    expect(instructionHash(null)).toBe('');
    expect(instructionHash('  ')).toBe('');
    expect(instructionHash('Same')).toBe(instructionHash('  Same  '));
    expect(instructionHash('Same')).not.toBe(instructionHash('Different'));
    expect(instructionHash('Same')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('includes the style data, rules and budget in the system prompt', () => {
    const style = getNarrationStyle('mechanism');
    const prompt = composeScriptSystemPrompt(style, 2175);
    expect(prompt).toContain(style.label);
    expect(prompt).toContain(style.persona);
    expect(prompt).toContain(style.directive);
    for (const rule of style.scriptRules) expect(prompt).toContain(rule);
    expect(prompt).toContain('2175');
    expect(prompt).toContain(`${Math.round(style.fillerBudget * 100)}%`);
  });

  it('changes more than the label between two styles', () => {
    const brief = getNarrationStyle('brief');
    const chronicle = getNarrationStyle('chronicle');
    const a = composeScriptSystemPrompt(brief, 725);
    const b = composeScriptSystemPrompt(chronicle, 725);
    expect(a).not.toBe(b);
    expect(a).toContain(brief.directive);
    expect(b).toContain(chronicle.directive);
    expect(brief.directive).not.toBe(chronicle.directive);
  });

  it('differs only in the target number between 5 and 25 minutes', () => {
    const style = getNarrationStyle('fireside');
    const short = composeScriptSystemPrompt(style, 725);
    const long = composeScriptSystemPrompt(style, 3625);
    expect(short.replace('725', 'TARGET')).toBe(long.replace('3625', 'TARGET'));
  });

  it('builds a placeholder-free user prompt', () => {
    const style = getNarrationStyle('fireside');
    const prompt = composeScriptUserPrompt({
      outline: [{ heading: 'Part one', points: ['First point', 'Second point'] }],
      notes: ['A note from the book.'],
      targetWords: 725,
      style,
      instruction: 'Keep it gentle.',
    });
    expect(prompt).toContain('## Part one');
    expect(prompt).toContain('- First point');
    expect(prompt).toContain('NOTES:');
    expect(prompt).toContain('Keep it gentle.');
    expect(prompt).not.toContain('{');
    expect(prompt).not.toContain('}');
  });

  it('omits the instruction block when the instruction is empty', () => {
    const style = NARRATION_STYLES[0];
    const prompt = composeScriptUserPrompt({
      outline: [],
      notes: ['Only a note.'],
      targetWords: 725,
      style,
      instruction: '   ',
    });
    expect(prompt).not.toContain('ADDITIONAL LISTENER INSTRUCTION');
  });
});
