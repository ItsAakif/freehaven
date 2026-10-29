/**
 * Provider-agnostic inference contract.
 *
 * Every provider receives retrieved sources and must return citations that
 * refer to those source chunk ids. The UI validates citations before rendering,
 * so a hallucinated reference can never be shown as evidence.
 */

import type { Citation } from '@/domain/types';

export type AiTask = 'summary' | 'takeaways' | 'lesson' | 'answer' | 'explain';

export type GroundedSource = {
  chunkId: string;
  text: string;
  page?: number | null;
  sectionTitle?: string | null;
};

export type AiRequest = {
  task: AiTask;
  /** User question or topic. Empty for summarisation. */
  query?: string;
  sources: GroundedSource[];
  length?: 'short' | 'medium' | 'long';
};

export type AiResponse = {
  text: string;
  citations: Citation[];
  provider: string;
  model?: string;
  /** True when the provider fell back to an extractive answer. */
  degraded?: boolean;
};

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

export interface AiProvider {
  readonly id: string;
  readonly label: string;
  /** Whether this provider can run right now (e.g. key present, endpoint set). */
  isAvailable(): Promise<boolean>;
  generate(request: AiRequest): Promise<AiResponse>;
}

export const ABSTAIN_TEXT =
  'I could not find enough evidence in this source to answer that. Try rephrasing, or open a passage and ask again.';
