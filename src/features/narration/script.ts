/**
 * Deterministic narration script prompts.
 *
 * This is a template, not a generator: styles contribute their data, and the
 * same inputs always produce the same prompt. Pure module (no Expo, no clocks).
 */

import { fnv1a32 } from '@/lib/hash';
import type { NarrationStylePreset } from './styles';

export type OutlineNode = { heading: string; points: string[]; chunkIds?: string[] };

/** Max characters allowed in a listener instruction. */
export const MAX_INSTRUCTION_CHARS = 280;

/**
 * Trim, collapse whitespace, strip newlines/markdown fences and prompt braces,
 * then cap at 280 characters. Whitespace-only input becomes ''.
 */
export function sanitiseInstruction(raw: string): string {
  if (typeof raw !== 'string') return '';
  const singleLine = raw
    .replace(/\r\n?/g, '\n')
    .replace(/```+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[{}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return singleLine.slice(0, MAX_INSTRUCTION_CHARS).trim();
}

/** FNV-1a over the sanitised instruction; 8 hex chars, '' when empty. */
export function instructionHash(instruction: string | null | undefined): string {
  const clean = sanitiseInstruction(instruction ?? '');
  if (!clean) return '';
  return fnv1a32(clean);
}

export function composeScriptSystemPrompt(
  style: NarrationStylePreset,
  targetWords: number,
): string {
  const words = Math.max(1, Math.round(targetWords));
  const fillerCeiling = Math.round(style.fillerBudget * 100);
  const ruleLines = style.scriptRules.map((rule) => `- ${rule}`).join('\n');

  return [
    'You are writing a spoken-word audio guide about a book, for a listener who has not read it.',
    'You are not the author. You never address the author directly.',
    '',
    `STYLE: ${style.label} — ${style.persona}`,
    `DELIVERY: ${style.directive}`,
    'RULES:',
    '- Use only the notes and outline supplied. Do not add facts, numbers, names or quotations that are',
    '  not in them.',
    '- No preamble ("In this book…"), no meta-commentary about being an AI, no closing summary unless the',
    '  style asks for one.',
    '- Plain spoken prose. No bullet points, no markdown headings, no stage directions, no emoji.',
    '- Write in the second person only where the style directive calls for it.',
    `- Target ${words} words (±10%).`,
    ruleLines,
    `- Connective commentary must stay under ${fillerCeiling}% of sentences.`,
  ].join('\n');
}

export function composeScriptUserPrompt(input: {
  outline: OutlineNode[];
  notes: string[];
  targetWords: number;
  style: NarrationStylePreset;
  instruction?: string | null;
}): string {
  const outlineLines: string[] = [];
  for (const node of input.outline) {
    outlineLines.push(`## ${node.heading}`);
    for (const point of node.points) outlineLines.push(`- ${point}`);
  }

  const notes = input.notes.map((note) => note.trim()).filter(Boolean);
  const instruction = sanitiseInstruction(input.instruction ?? '');

  const parts = [
    outlineLines.join('\n'),
    `NOTES:\n${notes.join('\n')}`,
  ].filter((part) => part.trim().length > 0);

  if (instruction) {
    parts.push(
      `ADDITIONAL LISTENER INSTRUCTION (follow it unless it conflicts with the rules above):\n${instruction}`,
    );
  }

  return parts.join('\n\n');
}
