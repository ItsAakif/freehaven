/**
 * Generation job domain types.
 *
 * Types and constants only: no Expo, React or SQLite imports, so both the data
 * layer and pure feature modules can depend on this file.
 */

export type GenerationJobType = 'narration.generate';
export type GenerationStage = 'map' | 'merge' | 'reduce' | 'expand' | 'synth';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type JobUnitStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobRecord {
  id: string;
  type: GenerationJobType;
  renditionId: string | null;
  status: JobStatus;
  stage: GenerationStage | null;
  progress: number;
  unitsDone: number;
  unitsTotal: number;
  etaRemainingMs: number | null;
  etaLowMs: number | null;
  etaHighMs: number | null;
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
  cancelRequested: boolean;
  attempts: number;
  scriptHash: string | null;
  synthHash: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobUnit {
  id: string;
  jobId: string;
  stage: GenerationStage;
  ordinal: number;
  status: JobUnitStatus;
  inputKey: string;
  payloadJson: string | null;
  resultJson: string | null;
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  error: string | null;
}

export const JOB_HEARTBEAT_MS = 10_000;
/** Four missed heartbeats before a foreground sweep treats the job as orphaned. */
export const JOB_LEASE_MS = 45_000;
/** Maximum DB writes per second while a job is running. */
export const JOB_PROGRESS_WRITE_MS = 750;
