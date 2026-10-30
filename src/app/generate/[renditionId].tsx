import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import {
  Screen,
  Header,
  AppText,
  Card,
  Button,
  ProgressBar,
  SectionHeader,
  Divider,
  EmptyState,
  LoadingBlock,
} from '@/design/ui';
import { Icon, type IconName } from '@/design/icon';
import { space } from '@/design/tokens';
import { useTheme } from '@/design/theme';
import { getBook } from '@/data/repositories/books';
import { getDocument } from '@/data/repositories/reading';
import { getRendition, renditionStats } from '@/data/repositories/renditions';
import {
  getActiveJobForRendition,
  getJob,
  listJobUnits,
  listJobsForRendition,
} from '@/data/repositories/jobs';
import { JOB_LEASE_MS, type GenerationStage, type JobRecord, type JobUnit } from '@/domain/jobs';
import type { Book, Document } from '@/domain/types';
import type { Rendition } from '@/domain/narration';
import { formatEtaRange, estimateEta } from '@/features/jobs/eta';
import { estimateWindows, planScriptUnits } from '@/features/jobs/planner';
import { planTiers } from '@/features/learning/windows';
import { wordsForMinutes } from '@/features/narration/lengths';
import {
  cancelGeneration,
  resumeGeneration,
  startGeneration,
} from '@/features/jobs/runner';
import { recoverGenerationOnForeground } from '@/features/jobs/launch';

const BACKGROUND_COPY =
  'Generation continues when you switch apps or lock the screen. It still stops if Android kills the app process; finished passages are kept and generation resumes from where it stopped on your next launch.';

const RANGE_COPY =
  'Times are a range because model calls vary. The estimate tightens after the first few passages.';

type Loaded = {
  rendition: Rendition;
  book: Book | null;
  document: Document | null;
  job: JobRecord | null;
  units: JobUnit[];
  segments: { total: number; ready: number; failed: number };
};

type StageRow = {
  stage: GenerationStage;
  label: string;
  optional?: boolean;
};

const STAGE_ROWS: StageRow[] = [
  { stage: 'map', label: 'Reading passages' },
  { stage: 'merge', label: 'Condensing notes', optional: true },
  { stage: 'reduce', label: 'Shaping the outline' },
  { stage: 'expand', label: 'Writing the script' },
  { stage: 'synth', label: 'Recording audio' },
];

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function confidenceFor(job: JobRecord): 'none' | 'low' | 'medium' | 'high' {
  if (job.etaRemainingMs === null) return 'none';
  if (job.unitsDone < 2) return 'low';
  if (job.unitsDone < 5) return 'medium';
  return 'high';
}

function isStale(job: JobRecord, now: number): boolean {
  return (
    job.status === 'running' &&
    job.heartbeatAt !== null &&
    now - job.heartbeatAt > JOB_LEASE_MS
  );
}

function KeepAwakeWhileRunning() {
  useKeepAwake('narration-generation');
  return null;
}

function stageRowState(
  row: StageRow,
  job: JobRecord,
  units: JobUnit[],
): { total: number; done: number; failed: number; active: boolean } {
  const stageUnits = units.filter((unit) => unit.stage === row.stage);
  const done = stageUnits.filter((unit) => unit.status === 'done').length;
  const failed = stageUnits.filter((unit) => unit.status === 'failed').length;
  const total = stageUnits.length;
  const active = job.status === 'running' && job.stage === row.stage;
  return { total, done, failed, active };
}

function iconFor(state: { total: number; done: number; failed: number; active: boolean }): {
  name: IconName;
  color: 'accent' | 'warm' | 'inkFaint' | 'danger';
} {
  if (state.failed > 0) return { name: 'alert-circle-outline', color: 'danger' };
  if (state.active) return { name: 'sync-outline', color: 'warm' };
  if (state.total > 0 && state.done >= state.total) return { name: 'checkmark-circle', color: 'accent' };
  return { name: 'ellipse-outline', color: 'inkFaint' };
}

export default function GenerateScreen() {
  const { renditionId } = useLocalSearchParams<{ renditionId: string }>();
  const { palette } = useTheme();
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(0);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoResumed = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<Loaded | null> => {
    if (!renditionId) {
      setData(null);
      setLoading(false);
      return null;
    }
    const rendition = await getRendition(renditionId);
    if (!rendition) {
      setData(null);
      setLoading(false);
      return null;
    }
    const [book, document, active, recent, stats] = await Promise.all([
      getBook(rendition.bookId),
      getDocument(rendition.bookId),
      getActiveJobForRendition(rendition.id),
      listJobsForRendition(rendition.id, 1),
      renditionStats(rendition.id),
    ]);
    const job = active ?? (await getJob(recent[0]?.id ?? '')) ?? null;
    const units = job ? await listJobUnits(job.id) : [];
    const loaded: Loaded = {
      rendition,
      book,
      document,
      job,
      units,
      segments: { total: stats.segments, ready: stats.ready, failed: stats.failed },
    };
    setData(loaded);
    setNow(Date.now());
    setLoading(false);
    return loaded;
  }, [renditionId]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setFocused(true);
      void refresh();
      const timer = setInterval(() => {
        if (alive) void refresh();
      }, 1_000);
      return () => {
        alive = false;
        setFocused(false);
        clearInterval(timer);
      };
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  // Resume a queued job once per mount/app-active: safe, unlike auto-starting a
  // deep link with no user gesture.
  useEffect(() => {
    const job = data?.job;
    if (!job || job.status !== 'queued') return;
    if (autoResumed.current === job.id) return;
    autoResumed.current = job.id;
    void resumeGeneration({ jobId: job.id, now: Date.now() }).finally(() => {
      void refresh();
    });
  }, [data?.job, refresh]);

  const start = useCallback(
    async (target?: Rendition) => {
      const rendition = target ?? data?.rendition;
      if (!rendition) return;
      setBusy('start');
      setError(null);
      try {
        const mode = rendition.scriptMd ? 'audio' : 'all';
        await startGeneration({ renditionId: rendition.id, mode, now: Date.now() });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
        autoResumed.current = null;
        await refresh();
      }
    },
    [data?.rendition, refresh],
  );

  const resume = useCallback(async () => {
    const job = data?.job;
    if (!job) return;
    setBusy('resume');
    setError(null);
    try {
      if (job.status === 'running') {
        await recoverGenerationOnForeground({ now: Date.now() });
        const fresh = await getActiveJobForRendition(job.renditionId ?? '');
        if (fresh?.status === 'queued') {
          await resumeGeneration({ jobId: fresh.id, now: Date.now() });
        } else {
          await start(data?.rendition ?? undefined);
        }
      } else if (job.status === 'queued') {
        await resumeGeneration({ jobId: job.id, now: Date.now() });
      } else {
        await start(data?.rendition ?? undefined);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      autoResumed.current = null;
      await refresh();
    }
  }, [data?.job, data?.rendition, refresh, start]);

  const cancel = useCallback(async () => {
    const job = data?.job;
    if (!job) return;
    setBusy('cancel');
    setError(null);
    try {
      await cancelGeneration({ jobId: job.id, now: Date.now() });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      await refresh();
    }
  }, [data?.job, refresh]);

  const preflightEstimate = useMemo(() => {
    const rendition = data?.rendition;
    if (!rendition) return null;
    const chars = Math.max(0, (data?.document?.wordCount ?? 0) * 6);
    const tier = planTiers(chars);
    const plan = planScriptUnits({
      chars,
      windows: estimateWindows(chars),
      tiers: tier,
      targetWords: wordsForMinutes(rendition.length),
    });
    const order: GenerationStage[] = plan.perStage.merge > 0
      ? ['map', 'merge', 'reduce', 'expand']
      : ['map', 'reduce', 'expand'];
    const eta = estimateEta({
      now,
      startedAt: null,
      heartbeatAt: null,
      order,
      state: {
        map: { total: plan.perStage.map, done: 0 },
        merge: { total: plan.perStage.merge, done: 0 },
        reduce: { total: plan.perStage.reduce, done: 0 },
        expand: { total: plan.perStage.expand, done: 0 },
      },
      currentStage: null,
      inFlightElapsedMs: 0,
      samples: [],
      engine: rendition.engine,
    });
    return { ...formatEtaRange(eta), calls: tier.estimatedCalls };
  }, [data?.document?.wordCount, data?.rendition, now]);

  if (loading) {
    return (
      <Screen>
        <Header title="Generating" onBack={() => router.back()} />
        <LoadingBlock label="Reading the job…" />
      </Screen>
    );
  }

  if (!renditionId || !data) {
    return (
      <Screen>
        <Header title="Generating" onBack={() => router.back()} />
        <EmptyState
          icon="alert-circle-outline"
          title="Narration not found"
          body="This narration may have been removed. Open the book or library to make a new one."
          actionLabel="Back to library"
          onAction={() => router.replace('/library')}
        />
      </Screen>
    );
  }

  const { rendition, book, document, job, units, segments } = data;

  if (!document) {
    return (
      <Screen>
        <Header title="Generating" subtitle={book?.title} onBack={() => router.back()} />
        <EmptyState
          icon="book-outline"
          title="Narration needs extracted text"
          body="Import a book or download a public-domain edition first. Narration is written from the text already on this device."
          actionLabel="Open book"
          onAction={() => router.replace({ pathname: '/book/[id]', params: { id: rendition.bookId } })}
        />
      </Screen>
    );
  }

  const stale = job ? isStale(job, now) : false;
  const running = job?.status === 'running' && !stale;
  const paused = job?.status === 'queued' || stale;
  const terminal = job?.status === 'done' || job?.status === 'failed' || job?.status === 'cancelled';
  const segmentTotal = segments.total;

  return (
    <Screen>
      <Header title="Generating" subtitle={book?.title} onBack={() => router.back()} />
      {focused && running ? <KeepAwakeWhileRunning /> : null}

      {!job ? (
        <Card style={{ backgroundColor: palette.surfaceAlt }}>
          <AppText variant="bodySm" style={{ fontWeight: '600' }}>
            {rendition.scriptMd ? 'Ready to record audio' : 'Ready to write this narration'}
          </AppText>
          <AppText variant="caption" faint style={{ marginTop: 4 }}>
            {preflightEstimate
              ? `${preflightEstimate.calls} model calls, ${preflightEstimate.short.replace(/ left$/i, '').toLowerCase()}`
              : 'Estimating…'}{' '}
            · {rendition.length} min ·{' '}
            {rendition.engine === 'device' ? 'device voice' : rendition.engine}
          </AppText>
          <View style={{ marginTop: space.md }}>
            <Button
              label={rendition.scriptMd ? 'Generate audio' : 'Start generation'}
              icon="mic-outline"
              loading={busy === 'start'}
              onPress={() => void start(rendition)}
            />
          </View>
        </Card>
      ) : null}

      {job && (running || paused) ? (
        <>
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                {running ? 'Working' : 'Paused'}
              </AppText>
              <AppText variant="caption" faint>
                {Math.round(job.progress * 100)}%
              </AppText>
            </View>
            <View style={{ marginTop: space.sm }}>
              <ProgressBar value={job.progress} height={8} />
            </View>
            <AppText variant="caption" faint style={{ marginTop: space.sm }}>
              {job.unitsDone} of {job.unitsTotal || '?'} steps
              {job.startedAt && job.unitsDone > 0
                ? ` · ~${Math.max(1, Math.round(job.unitsDone / Math.max(1 / 60, (now - job.startedAt) / 60_000)))} steps/min`
                : ''}
            </AppText>
          </Card>

          <View style={{ gap: 4 }}>
            <AppText variant="subheading">
              {formatEtaRange({
                remainingMs: job.etaRemainingMs,
                lowMs: job.etaLowMs,
                highMs: job.etaHighMs,
                confidence: confidenceFor(job),
              }).short}
            </AppText>
            <AppText variant="caption" faint>
              Elapsed {formatElapsed(job.startedAt ? now - job.startedAt : 0)} ·{' '}
              {Math.round(job.progress * 100)}% ·{' '}
              {confidenceFor(job) === 'high'
                ? 'measured pace'
                : confidenceFor(job) === 'medium'
                  ? 'estimate tightening'
                  : 'rough estimate'}
            </AppText>
          </View>

          <SectionHeader title="Stages" />
          <Card padded={false}>
            {STAGE_ROWS.filter((row) => {
              if (!row.optional) return true;
              const state = stageRowState(row, job, units);
              if (state.total > 0) return true;
              return job.stage === 'merge';
            }).map((row, index, rows) => {
              const state = stageRowState(row, job, units);
              const icon = iconFor(state);
              const color =
                icon.color === 'accent'
                  ? palette.accent
                  : icon.color === 'warm'
                    ? palette.warm
                    : icon.color === 'danger'
                      ? palette.danger
                      : palette.inkFaint;
              const total = row.stage === 'synth' && state.total === 0 ? segmentTotal : state.total;
              const done = row.stage === 'synth' && state.total === 0 ? segments.ready : state.done;
              return (
                <View key={row.stage}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.md,
                      paddingHorizontal: space.lg,
                      paddingVertical: space.md,
                    }}
                  >
                    <Icon name={icon.name} size={18} color={color} />
                    <AppText variant="bodySm" style={{ flex: 1 }}>
                      {row.label}
                    </AppText>
                    <AppText variant="caption" faint>
                      {total > 0 ? `${done}/${total}${row.stage === 'synth' ? ' segments' : ''}` : '—'}
                    </AppText>
                  </View>
                  {index < rows.length - 1 ? <Divider /> : null}
                </View>
              );
            })}
          </Card>

          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
            {running ? (
              <Button
                label="Cancel"
                variant="ghost"
                size="sm"
                loading={busy === 'cancel'}
                onPress={() => void cancel()}
              />
            ) : (
              <Button
                label="Resume"
                icon="refresh-outline"
                size="sm"
                loading={busy === 'resume'}
                onPress={() => void resume()}
              />
            )}
            {rendition.scriptMd ? (
              <Button
                label="Open player"
                icon="headset-outline"
                variant="secondary"
                size="sm"
                onPress={() =>
                  router.push({
                    pathname: '/listen/[id]',
                    params: { id: rendition.bookId, rendition: rendition.id },
                  })
                }
              />
            ) : null}
          </View>
        </>
      ) : null}

      {job?.status === 'done' ? (
        <>
          <Card style={{ backgroundColor: palette.accentSoft, borderColor: palette.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <Icon name="checkmark-circle" size={22} color={palette.accent} />
              <View style={{ flex: 1 }}>
                <AppText variant="bodySm" style={{ fontWeight: '600' }}>
                  Narration ready
                </AppText>
                <AppText variant="caption" faint>
                  {segments.ready}/{segmentTotal || segments.ready} segments recorded ·{' '}
                  {formatElapsed(
                    job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : 0,
                  )}{' '}
                  elapsed
                </AppText>
              </View>
            </View>
          </Card>
          <Button
            label="Open player"
            icon="headset-outline"
            onPress={() =>
              router.push({
                pathname: '/listen/[id]',
                params: { id: rendition.bookId, rendition: rendition.id },
              })
            }
          />
        </>
      ) : null}

      {(job?.status === 'failed' || job?.status === 'cancelled') ? (
        <>
          <Card style={{ borderColor: palette.dangerSoft }}>
            <AppText variant="bodySm" color={palette.danger} style={{ fontWeight: '600' }}>
              {job.status === 'cancelled' ? 'Cancelled' : 'Generation stopped'}
            </AppText>
            <AppText variant="caption" muted style={{ marginTop: 4 }}>
              {job.error === 'cancelled' || job.status === 'cancelled'
                ? 'Cancelled. Finished work is kept.'
                : job.error ?? 'The last run stopped before every step finished.'}
            </AppText>
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
              <Button
                label="Resume"
                icon="refresh-outline"
                size="sm"
                loading={busy === 'resume'}
                onPress={() => void resume()}
              />
              {rendition.scriptMd ? (
                <Button
                  label="Open player"
                  icon="headset-outline"
                  variant="secondary"
                  size="sm"
                  onPress={() =>
                    router.push({
                      pathname: '/listen/[id]',
                      params: { id: rendition.bookId, rendition: rendition.id },
                    })
                  }
                />
              ) : null}
            </View>
          </Card>
        </>
      ) : null}

      {error ? (
        <AppText variant="caption" color={palette.danger}>
          {error}
        </AppText>
      ) : null}

      {!terminal ? (
        <AppText variant="caption" faint>
          {BACKGROUND_COPY}
        </AppText>
      ) : null}
      <AppText variant="caption" faint>
        {RANGE_COPY}
      </AppText>
    </Screen>
  );
}
