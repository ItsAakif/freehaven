/**
 * Generation job runner.
 *
 * One module-scoped runner per job id. The screen only polls job rows; leaving
 * it never aborts the work. All state lives in SQLite, so a killed process can
 * resume from completed units on the next launch.
 */

import { resolveProvider } from '@/ai';
import { getBook } from '@/data/repositories/books';
import { getDocument, listSections } from '@/data/repositories/reading';
import {
  adoptDoneUnits,
  beginUnit,
  cancelJob,
  claimJob,
  createJob,
  deleteJobUnits,
  failUnit,
  finishJob,
  finishUnit,
  getActiveJobForRendition,
  getJob,
  getJobPayload,
  heartbeat,
  listJobUnits,
  listJobsForRendition,
  recoverStaleJobs,
  requestCancel,
} from '@/data/repositories/jobs';
import {
  getRendition,
  listSegments,
  replaceSegments,
  setRenditionStatus,
} from '@/data/repositories/renditions';
import {
  JOB_HEARTBEAT_MS,
  JOB_PROGRESS_WRITE_MS,
  type GenerationStage,
  type JobRecord,
  type JobUnit,
} from '@/domain/jobs';
import type { Rendition } from '@/domain/narration';
import {
  createScript,
  planRenditionSegments,
  synthesiseRendition,
} from '@/features/narration/generate';
import { probeNarrationEngines, type NarrationEngine } from '@/features/narration/engines';
import type { SummaryCheckpoint } from '@/features/learning/summarise';
import { planTiers } from '@/features/learning/windows';
import { wordsForMinutes } from '@/features/narration/lengths';
import {
  estimateEta,
  type EtaOutput,
  type EtaPrevious,
  type EtaSample,
  type EtaStageState,
} from './eta';
import {
  PLAN_VERSION,
  SEGMENT_PLAN_VERSION,
  scriptStageKey,
  synthStageKey,
  unitInputKey,
} from './checkpoints';
import {
  estimateWindows,
  planScriptUnits,
  scriptHashFor,
  synthHashFor,
} from './planner';
import {
  FOREGROUND_UPDATE_INTERVAL_MS,
  foregroundProgressText,
  getForegroundBridge,
} from './foreground';
import { notifyGenerationFinished } from './notify';

export type StartResult =
  | { kind: 'started'; jobId: string }
  | { kind: 'resumed'; jobId: string }
  | { kind: 'already_running'; jobId: string }
  | { kind: 'blocked'; reason: 'no_document' | 'no_engine' | 'unsupported' };

type Mode = 'script' | 'audio' | 'all';

const SCRIPT_STAGES: GenerationStage[] = ['map', 'merge', 'reduce', 'expand'];

const controllers = new Map<string, AbortController>();

function safeMode(value: unknown): Mode {
  return value === 'script' || value === 'audio' || value === 'all' ? value : 'all';
}

function includesScript(mode: Mode): boolean {
  return mode !== 'audio';
}

function includesAudio(mode: Mode): boolean {
  return mode !== 'script';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function scriptProviderId(): Promise<string> {
  try {
    return (await resolveProvider()).id;
  } catch {
    return 'unavailable';
  }
}

async function replanSegments(rendition: Rendition): Promise<void> {
  if (!rendition.scriptMd) return;
  const document = await getDocument(rendition.bookId);
  const sections = document ? await listSections(document.id) : [];
  const planned = planRenditionSegments({
    rendition,
    script: rendition.scriptMd,
    sections: sections.map((section) => ({ id: section.id, title: section.title ?? null })),
  });
  await replaceSegments(rendition.id, planned);
}

async function adoptPreviousCheckpoints(input: {
  jobId: string;
  renditionId: string;
  scriptHash: string;
  synthHash: string;
  mode: Mode;
  now: number;
}): Promise<void> {
  const history = await listJobsForRendition(input.renditionId, 10);
  const previous = history.filter((job) => job.id !== input.jobId);

  if (includesScript(input.mode)) {
    const source = previous.find((job) => job.scriptHash === input.scriptHash);
    if (source) {
      await adoptDoneUnits({
        fromJobId: source.id,
        toJobId: input.jobId,
        stages: SCRIPT_STAGES,
        now: input.now,
      });
    }
  }

  if (includesAudio(input.mode)) {
    const source = previous.find((job) => job.synthHash === input.synthHash);
    if (source) {
      await adoptDoneUnits({
        fromJobId: source.id,
        toJobId: input.jobId,
        stages: ['synth'],
        now: input.now,
      });
    }
  }
}

type ProgressSnapshot = {
  now: number;
  stage: GenerationStage | null;
  done: number;
  total: number;
  eta: EtaOutput;
};

type ForegroundReporter = {
  start(): void;
  update(snapshot: ProgressSnapshot): void;
  stop(): void;
};

/**
 * Owns the foreground service lifecycle for one runner. Notifications are
 * throttled by the caller; the bridge is resolved on every call so tests (and
 * a future platform switch) can replace it without restarting a job.
 */
function createForegroundReporter(bookTitle: string | null): ForegroundReporter {
  const title = bookTitle ? `Generating ${bookTitle}` : 'Generating narration';
  let active = false;
  let lastSentAt = 0;
  let lastStage: GenerationStage | null = null;

  const fire = (run: () => Promise<void>): void => {
    try {
      void run().catch(() => {});
    } catch {
      // A notification failure must never fail a generation job.
    }
  };

  return {
    start() {
      if (active) return;
      active = true;
      lastSentAt = 0;
      lastStage = null;
      fire(() =>
        getForegroundBridge().start({ title, text: 'Preparing generation...' }),
      );
    },
    update(snapshot) {
      if (!active) return;
      // Stage changes are worth an immediate update; everything else waits at
      // least the throttle interval so the tray is never hammered.
      const stageChanged = snapshot.stage !== lastStage;
      if (!stageChanged && snapshot.now - lastSentAt < FOREGROUND_UPDATE_INTERVAL_MS) {
        return;
      }
      lastSentAt = snapshot.now;
      lastStage = snapshot.stage;
      fire(() =>
        getForegroundBridge().update({
          text: foregroundProgressText({ stage: snapshot.stage, eta: snapshot.eta }),
          progress:
            snapshot.total > 0
              ? Math.round((snapshot.done / snapshot.total) * 100)
              : -1,
        }),
      );
    },
    stop() {
      if (!active) return;
      active = false;
      fire(() => getForegroundBridge().stop());
    },
  };
}

class ProgressTracker {
  private state: Partial<Record<GenerationStage, EtaStageState>> = {};
  private samples: EtaSample[] = [];
  private previous: EtaPrevious | null = null;
  private lastWrite = 0;
  private lastSampleStage: GenerationStage | null = null;
  private lastSampleAt: number | null = null;

  currentStage: GenerationStage | null = null;
  inFlightStartedAt: number | null = null;

  constructor(
    private readonly job: JobRecord,
    private readonly order: readonly GenerationStage[],
    private readonly engine: Rendition['engine'],
    private readonly onSnapshot?: (snapshot: ProgressSnapshot) => void,
  ) {}

  setStage(stage: GenerationStage | null, now: number): void {
    this.currentStage = stage;
    this.inFlightStartedAt = now;
    if (stage) {
      const existing = this.state[stage];
      if (!existing) this.state[stage] = { total: 0, done: 0 };
    }
    this.onSnapshot?.(this.snapshot(now));
  }

  set(stage: GenerationStage, done: number, total: number, now: number): Promise<void> {
    if (this.lastSampleAt !== null && this.lastSampleStage) {
      this.samples.push({
        stage: this.lastSampleStage,
        durationMs: Math.max(0, now - this.lastSampleAt),
        at: now,
      });
    }
    this.lastSampleStage = stage;
    this.lastSampleAt = now;
    this.state[stage] = { done: Math.max(0, done), total: Math.max(0, total) };
    if (this.currentStage !== stage) this.setStage(stage, now);
    return this.write(now, false);
  }

  async flush(now: number): Promise<void> {
    await this.write(now, true);
  }

  private snapshot(now: number): ProgressSnapshot {
    let done = 0;
    let total = 0;
    for (const stage of this.order) {
      const stageState = this.state[stage];
      done += stageState?.done ?? 0;
      total += stageState?.total ?? 0;
    }
    const eta = estimateEta({
      now,
      startedAt: this.job.startedAt,
      heartbeatAt: now,
      order: this.order,
      state: this.state,
      currentStage: this.currentStage,
      inFlightElapsedMs:
        this.inFlightStartedAt !== null ? Math.max(0, now - this.inFlightStartedAt) : 0,
      samples: this.samples,
      engine: this.engine,
      previous: this.previous,
    });
    if (eta.remainingMs !== null) {
      this.previous = { at: now, remainingMs: eta.remainingMs };
    }
    return { now, stage: this.currentStage, done, total, eta };
  }

  private async write(now: number, force: boolean): Promise<void> {
    const snapshot = this.snapshot(now);
    this.onSnapshot?.(snapshot);
    if (!force && now - this.lastWrite < JOB_PROGRESS_WRITE_MS) return;
    this.lastWrite = now;
    const patch: {
      unitsDone: number;
      unitsTotal: number;
      etaRemainingMs: number | null;
      etaLowMs: number | null;
      etaHighMs: number | null;
      progress: number;
      stage?: GenerationStage;
    } = {
      unitsDone: snapshot.done,
      unitsTotal: snapshot.total,
      etaRemainingMs: snapshot.eta.remainingMs,
      etaLowMs: snapshot.eta.lowMs,
      etaHighMs: snapshot.eta.highMs,
      progress: snapshot.total ? snapshot.done / snapshot.total : 0,
    };
    if (snapshot.stage) patch.stage = snapshot.stage;
    await heartbeat(this.job.id, patch, now);
  }
}

async function runScriptPhase(input: {
  job: JobRecord;
  rendition: Rendition;
  tracker: ProgressTracker;
  signal: AbortSignal;
  providerId: string;
}): Promise<void> {
  const document = await getDocument(input.rendition.bookId);
  const stageKey = scriptStageKey({
    bookId: input.rendition.bookId,
    documentId: document?.id ?? '',
    styleId: input.rendition.styleId,
    length: input.rendition.length,
    instructionHash: input.rendition.instructionHash ?? '',
    planVersion: PLAN_VERSION,
    providerId: input.providerId,
    model: null,
  });

  const units = new Map<string, JobUnit>();
  for (const unit of await listJobUnits(input.job.id)) {
    units.set(`${unit.stage}:${unit.ordinal}`, unit);
  }
  const keyFor = (stage: GenerationStage, ordinal: number, value: string) =>
    unitInputKey(stageKey, stage, ordinal, value);

  const checkpoint: SummaryCheckpoint = {
    async load(stage, ordinal, inputKey) {
      const unit = units.get(`${stage}:${ordinal}`);
      const key = keyFor(stage, ordinal, inputKey);
      if (!unit || unit.status !== 'done' || unit.inputKey !== key || !unit.resultJson) return null;
      try {
        return JSON.parse(unit.resultJson) as unknown;
      } catch {
        return null;
      }
    },
    async begin(stage, ordinal, inputKey, payload) {
      await beginUnit({
        jobId: input.job.id,
        stage,
        ordinal,
        inputKey: keyFor(stage, ordinal, inputKey),
        payloadJson: JSON.stringify(payload),
        now: Date.now(),
      });
    },
    async save(stage, ordinal, inputKey, result, durationMs) {
      const key = keyFor(stage, ordinal, inputKey);
      await finishUnit({
        jobId: input.job.id,
        stage,
        ordinal,
        inputKey: key,
        resultJson: JSON.stringify(result),
        durationMs,
        now: Date.now(),
      });
      units.set(`${stage}:${ordinal}`, {
        id: '',
        jobId: input.job.id,
        stage,
        ordinal,
        status: 'done',
        inputKey: key,
        payloadJson: null,
        resultJson: JSON.stringify(result),
        attempts: 1,
        startedAt: null,
        finishedAt: Date.now(),
        durationMs,
        error: null,
      });
    },
    async fail(stage, ordinal, inputKey, error, durationMs) {
      await failUnit({
        jobId: input.job.id,
        stage,
        ordinal,
        inputKey: keyFor(stage, ordinal, inputKey),
        error,
        durationMs,
        now: Date.now(),
      });
    },
    cancelled() {
      return input.signal.aborted;
    },
  };

  input.tracker.setStage('map', Date.now());
  await createScript({
    renditionId: input.rendition.id,
    signal: input.signal,
    checkpoint,
    onProgress: (progress) => {
      void input.tracker.set(progress.stage, progress.done, progress.total, Date.now());
    },
  });
  await input.tracker.flush(Date.now());
}

async function runSynthPhase(input: {
  job: JobRecord;
  rendition: Rendition;
  tracker: ProgressTracker;
  signal: AbortSignal;
  engine?: NarrationEngine;
}): Promise<{ done: number; failed: number }> {
  const segments = await listSegments(input.rendition.id);
  const total = segments.length;
  const finished = new Set<number>();
  const started = new Set<number>();
  for (const segment of segments) {
    if (segment.status === 'ready') finished.add(segment.ordinal);
  }

  const synthKey = synthStageKey({
    renditionId: input.rendition.id,
    engine: input.rendition.engine,
    voice: input.rendition.voice,
    model: input.rendition.model,
    instructionHash: input.rendition.instructionHash ?? '',
    segmentPlanVersion: SEGMENT_PLAN_VERSION,
  });

  const keyFor = (ordinal: number, speechKey: string) =>
    unitInputKey(synthKey, 'synth', ordinal, speechKey || `segment-${ordinal}`);

  input.tracker.setStage('synth', Date.now());
  await input.tracker.set('synth', finished.size, total, Date.now());

  return synthesiseRendition({
    renditionId: input.rendition.id,
    engine: input.engine,
    signal: input.signal,
    onProgress: (progress) => {
      void input.tracker.set('synth', progress.done, progress.total, Date.now());
    },
    onSegment: async (segment) => {
      const now = Date.now();
      const key = keyFor(segment.ordinal, segment.speechKey);
      if (segment.status === 'start') {
        input.tracker.setStage('synth', now);
        await beginUnit({
          jobId: input.job.id,
          stage: 'synth',
          ordinal: segment.ordinal,
          inputKey: key,
          payloadJson: JSON.stringify({ speechKey: segment.speechKey }),
          now,
        });
        started.add(segment.ordinal);
        return;
      }

      if (segment.status === 'done' || segment.status === 'skipped') {
        const begun = started.has(segment.ordinal)
          ? true
          : await beginUnit({
              jobId: input.job.id,
              stage: 'synth',
              ordinal: segment.ordinal,
              inputKey: key,
              payloadJson: JSON.stringify({ speechKey: segment.speechKey }),
              now,
            });
        started.delete(segment.ordinal);
        if (begun) {
          await finishUnit({
            jobId: input.job.id,
            stage: 'synth',
            ordinal: segment.ordinal,
            inputKey: key,
            resultJson: JSON.stringify({
              speechKey: segment.speechKey,
              durationMs: segment.durationMs ?? null,
            }),
            durationMs: segment.durationMs ?? 0,
            now,
          });
        }
        finished.add(segment.ordinal);
        await input.tracker.set('synth', finished.size, total, now);
        return;
      }

      started.delete(segment.ordinal);
      await failUnit({
        jobId: input.job.id,
        stage: 'synth',
        ordinal: segment.ordinal,
        inputKey: key,
        error: 'segment failed',
        durationMs: 0,
        now,
      });
      finished.add(segment.ordinal);
      await input.tracker.set('synth', finished.size, total, now);
    },
  });
}

async function runJob(input: {
  jobId: string;
  renditionId: string;
  mode: Mode;
  signal: AbortSignal;
  engine?: NarrationEngine;
  onJob?: (job: JobRecord) => void;
}): Promise<void> {
  const job = await getJob(input.jobId);
  if (!job) return;
  const rendition = await getRendition(input.renditionId);
  if (!rendition) {
    await finishJob(input.jobId, 'failed', { error: 'Rendition not found.', now: Date.now() });
    return;
  }

  const order: GenerationStage[] = includesScript(input.mode)
    ? ['map', 'merge', 'reduce', 'expand']
    : [];
  if (includesAudio(input.mode)) order.push('synth');

  const book = await getBook(rendition.bookId).catch(() => null);
  const foreground = createForegroundReporter(book?.title ?? null);
  const tracker = new ProgressTracker(job, order, rendition.engine, (snapshot) => {
    foreground.update(snapshot);
  });
  foreground.start();
  const heartbeatTimer = setInterval(() => {
    void tracker.flush(Date.now());
    void getJob(input.jobId)
      .then((latest) => {
        if (latest) input.onJob?.(latest);
      })
      .catch(() => {});
  }, JOB_HEARTBEAT_MS);
  const timer = heartbeatTimer as unknown as { unref?: () => void };
  timer.unref?.();

  try {
    if (includesScript(input.mode)) {
      await runScriptPhase({
        job,
        rendition,
        tracker,
        signal: input.signal,
        providerId: await scriptProviderId(),
      });
    }
    if (input.signal.aborted) throw new Error('cancelled');

    if (includesAudio(input.mode)) {
      const result = await runSynthPhase({
        job,
        rendition,
        tracker,
        signal: input.signal,
        engine: input.engine,
      });
      if (input.signal.aborted) throw new Error('cancelled');
      if (result.failed > 0) {
        await finishJob(input.jobId, 'failed', {
          error: `${result.failed} segment(s) failed`,
          now: Date.now(),
        });
        const latest = await getJob(input.jobId);
        if (latest) input.onJob?.(latest);
        return;
      }
    }

    await finishJob(input.jobId, 'done', { now: Date.now() });
    const latest = await getJob(input.jobId);
    if (latest) {
      input.onJob?.(latest);
      await notifyGenerationFinished({
        job: latest,
        bookTitle: book?.title ?? 'Your narration is ready',
      });
    }
  } catch (error) {
    const latest = await getJob(input.jobId);
    if (input.signal.aborted || latest?.cancelRequested || errorMessage(error) === 'cancelled') {
      await cancelJob(input.jobId, { now: Date.now(), error: 'cancelled' });
      await setRenditionStatus(rendition.id, 'failed', 'cancelled');
    } else {
      await finishJob(input.jobId, 'failed', {
        error: errorMessage(error),
        now: Date.now(),
      });
    }
    const after = await getJob(input.jobId);
    if (after) input.onJob?.(after);
  } finally {
    clearInterval(heartbeatTimer);
    controllers.delete(input.jobId);
    // Success, failure, cancel and abort all converge here.
    foreground.stop();
  }
}

export async function startGeneration(input: {
  renditionId: string;
  mode: 'script' | 'audio' | 'all';
  now: number;
  signal?: AbortSignal;
  engine?: NarrationEngine;
  onJob?: (job: JobRecord) => void;
}): Promise<StartResult> {
  const rendition = await getRendition(input.renditionId);
  if (!rendition) return { kind: 'blocked', reason: 'unsupported' };

  const document = await getDocument(rendition.bookId);
  if (!document) return { kind: 'blocked', reason: 'no_document' };

  if (includesAudio(input.mode) && !input.engine && rendition.engine !== 'device') {
    const probes = await probeNarrationEngines();
    if (!probes[rendition.engine]?.available) {
      return { kind: 'blocked', reason: 'no_engine' };
    }
  }

  const providerId = await scriptProviderId();
  const scriptHash = scriptHashFor(rendition, document.id, providerId, null);
  const synthHash = synthHashFor(rendition);

  const active = await getActiveJobForRendition(rendition.id);
  if (
    active &&
    active.scriptHash === scriptHash &&
    active.synthHash === synthHash
  ) {
    return { kind: 'already_running', jobId: active.id };
  }

  if (active) {
    if (active.scriptHash !== scriptHash) {
      await cancelJob(active.id, { error: 'superseded', now: input.now });
      await deleteJobUnits(active.id, SCRIPT_STAGES);
    } else if (active.synthHash !== synthHash) {
      await deleteJobUnits(active.id, ['synth']);
    }
  }

  const history = await listJobsForRendition(rendition.id, 10);
  const latestSynthHash = history.find((job) => job.id !== active?.id)?.synthHash ?? null;
  if (
    includesAudio(input.mode) &&
    rendition.scriptMd &&
    latestSynthHash !== null &&
    latestSynthHash !== synthHash
  ) {
    await replanSegments(rendition);
  }

  const chars = Math.max(0, (document.wordCount ?? 0) * 6);
  const tier = planTiers(chars);
  const targetWords = planScriptUnits({
    chars,
    windows: estimateWindows(chars),
    tiers: tier,
    targetWords: wordsForMinutes(rendition.length),
  });
  const segments = includesAudio(input.mode) ? await listSegments(rendition.id) : [];
  const unitsTotal =
    (includesScript(input.mode) ? targetWords.unitsTotal : 0) + segments.length;

  const jobId = await createJob({
    type: 'narration.generate',
    renditionId: rendition.id,
    payload: {
      mode: input.mode,
      band: tier.band,
      levels: tier.levels,
      estimatedCalls: tier.estimatedCalls,
    },
    scriptHash,
    synthHash,
    unitsTotal,
    now: input.now,
  });

  await adoptPreviousCheckpoints({
    jobId,
    renditionId: rendition.id,
    scriptHash,
    synthHash,
    mode: input.mode,
    now: input.now,
  });

  const claimed = await claimJob(jobId, input.now);
  if (!claimed) {
    const existing = await getActiveJobForRendition(rendition.id);
    return existing
      ? { kind: 'already_running', jobId: existing.id }
      : { kind: 'blocked', reason: 'unsupported' };
  }

  const controller = new AbortController();
  controllers.set(jobId, controller);
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  await runJob({
    jobId,
    renditionId: rendition.id,
    mode: input.mode,
    signal: controller.signal,
    engine: input.engine,
    onJob: input.onJob,
  });
  return { kind: 'started', jobId };
}

export async function resumeGeneration(input: {
  jobId: string;
  now: number;
  signal?: AbortSignal;
  engine?: NarrationEngine;
  onJob?: (job: JobRecord) => void;
}): Promise<StartResult> {
  const job = await getJob(input.jobId);
  if (!job || !job.renditionId) return { kind: 'blocked', reason: 'unsupported' };
  if (job.status === 'running') return { kind: 'already_running', jobId: job.id };

  const payload = await getJobPayload(job.id);
  const mode = safeMode(
    payload && typeof payload === 'object' && 'mode' in payload
      ? (payload as { mode?: unknown }).mode
      : 'all',
  );

  if (job.status !== 'queued') {
    // A failed/cancelled/done job cannot be claimed; start a fresh job that
    // adopts any completed units through the normal start path.
    const restarted = await startGeneration({
      renditionId: job.renditionId,
      mode,
      now: input.now,
      signal: input.signal,
      engine: input.engine,
      onJob: input.onJob,
    });
    if (restarted.kind === 'started' || restarted.kind === 'already_running') {
      return { kind: 'resumed', jobId: restarted.jobId };
    }
    return restarted;
  }

  const claimed = await claimJob(job.id, input.now);
  if (!claimed) return { kind: 'already_running', jobId: job.id };

  const controller = new AbortController();
  controllers.set(job.id, controller);
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  await runJob({
    jobId: job.id,
    renditionId: job.renditionId,
    mode,
    signal: controller.signal,
    engine: input.engine,
    onJob: input.onJob,
  });
  return { kind: 'resumed', jobId: job.id };
}

export async function cancelGeneration(input: { jobId: string; now: number }): Promise<void> {
  await requestCancel(input.jobId, input.now);
  const controller = controllers.get(input.jobId);
  if (controller) {
    controller.abort();
    return;
  }
  await cancelJob(input.jobId, { now: input.now, error: 'cancelled' });
}

export async function recoverOnLaunch(input: {
  now: number;
}): Promise<{ recovered: number; cancelled: number }> {
  return recoverStaleJobs({ mode: 'boot', now: input.now });
}

/** Test seam: true when a runner is attached to this process for the job. */
export function isJobRunningInProcess(jobId: string): boolean {
  return controllers.has(jobId);
}
