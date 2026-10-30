/** @jest-environment node */
import { createTestDriver } from '@/data/__tests__/testDriver';
import { resetDriverForTests, setDriverForTests } from '@/data/db';
import {
  beginUnit,
  cancelJob,
  claimJob,
  createJob,
  finishJob,
  finishUnit,
  getJob,
  listJobUnits,
  recoverStaleJobs,
  requestCancel,
} from '@/data/repositories/jobs';

const RENDITION_ID = 'r1';

let driver: ReturnType<typeof createTestDriver>;

async function newJob(now = 1_000): Promise<string> {
  return createJob({
    type: 'narration.generate',
    renditionId: RENDITION_ID,
    payload: { mode: 'script' },
    scriptHash: 'script-hash',
    synthHash: 'synth-hash',
    unitsTotal: 4,
    now,
  });
}

describe('jobs repository', () => {
  beforeEach(async () => {
    driver = createTestDriver();
    await setDriverForTests(driver);
    await driver.run(
      "INSERT INTO books (id, title, source, access, created_at, updated_at) VALUES ('b','Book','import','user_import',0,0)",
    );
    await driver.run(
      `INSERT INTO renditions (id, book_id, language, style_id, length_preset, created_at, updated_at)
       VALUES (?, 'b', 'en', 'fireside', '15', 0, 0)`,
      [RENDITION_ID],
    );
  });

  afterEach(async () => {
    await resetDriverForTests();
    try {
      await driver.close();
    } catch {
      /* already closed */
    }
  });

  it('returns the first job id on a second create for the same rendition', async () => {
    const first = await newJob();
    const second = await newJob();
    expect(second).toBe(first);
    expect(await driver.all('SELECT id FROM jobs')).toHaveLength(1);
  });

  it('claims a queued job exactly once and increments attempts', async () => {
    const id = await newJob();
    expect(await claimJob(id, 2_000)).toBe(true);
    expect(await claimJob(id, 3_000)).toBe(false);
    const job = await getJob(id);
    expect(job?.status).toBe('running');
    expect(job?.attempts).toBe(1);
    expect(job?.startedAt).toBe(2_000);
  });

  it('counts retries on beginUnit and never clobbers a done unit', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    const unit = {
      jobId: id,
      stage: 'map' as const,
      ordinal: 0,
      inputKey: 'key-a',
      payloadJson: '{}',
    };
    expect(await beginUnit({ ...unit, now: 3_000 })).toBe(true);
    expect(await beginUnit({ ...unit, now: 3_100 })).toBe(true);

    const running = (await listJobUnits(id))[0];
    expect(running.attempts).toBe(2);
    expect(running.status).toBe('running');

    await finishUnit({ ...unit, resultJson: '{"notes":1}', durationMs: 50, now: 3_200 });
    expect(await beginUnit({ ...unit, now: 3_300 })).toBe(false);
    const done = (await listJobUnits(id))[0];
    expect(done.status).toBe('done');
    expect(done.resultJson).toBe('{"notes":1}');
  });

  it('discards a finish from a different input key', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    const unit = {
      jobId: id,
      stage: 'map' as const,
      ordinal: 0,
      inputKey: 'key-a',
      payloadJson: '{}',
    };
    await beginUnit({ ...unit, now: 3_000 });
    await finishUnit({ ...unit, resultJson: '"kept"', durationMs: 10, now: 3_100 });
    await finishUnit({
      ...unit,
      inputKey: 'key-b',
      resultJson: '"stale"',
      durationMs: 10,
      now: 3_200,
    });
    const row = (await listJobUnits(id))[0];
    expect(row.resultJson).toBe('"kept"');
    expect(row.finishedAt).toBe(3_100);
  });

  it('boot recovery requeues a fresh running job and its running unit', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    await beginUnit({
      jobId: id,
      stage: 'map',
      ordinal: 0,
      inputKey: 'key-a',
      payloadJson: '{}',
      now: 2_100,
    });

    const result = await recoverStaleJobs({ now: 2_200, mode: 'boot' });
    expect(result).toEqual({ recovered: 1, cancelled: 0 });
    expect((await getJob(id))?.status).toBe('queued');
    expect((await getJob(id))?.heartbeatAt).toBeNull();
    expect((await listJobUnits(id))[0].status).toBe('pending');
    expect((await listJobUnits(id))[0].error).toBe('interrupted');
  });

  it('lease recovery leaves a fresh heartbeat alone', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    await beginUnit({
      jobId: id,
      stage: 'map',
      ordinal: 0,
      inputKey: 'key-a',
      payloadJson: '{}',
      now: 2_100,
    });

    const result = await recoverStaleJobs({ now: 2_200, mode: 'lease' });
    expect(result).toEqual({ recovered: 0, cancelled: 0 });
    expect((await getJob(id))?.status).toBe('running');
    expect((await listJobUnits(id))[0].status).toBe('running');
  });

  it('lease recovery requeues an expired heartbeat', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    const result = await recoverStaleJobs({ now: 200_000, mode: 'lease' });
    expect(result.recovered).toBe(1);
    expect((await getJob(id))?.status).toBe('queued');
  });

  it('cancels a requested job without requeueing its running units', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    await beginUnit({
      jobId: id,
      stage: 'map',
      ordinal: 0,
      inputKey: 'key-a',
      payloadJson: '{}',
      now: 2_100,
    });
    await requestCancel(id, 2_200);
    expect((await getJob(id))?.cancelRequested).toBe(true);

    const result = await recoverStaleJobs({ now: 2_300, mode: 'boot' });
    expect(result).toEqual({ recovered: 0, cancelled: 1 });
    const job = await getJob(id);
    expect(job?.status).toBe('cancelled');
    expect(job?.finishedAt).toBe(2_300);
    expect((await listJobUnits(id))[0].status).toBe('running');
  });

  it('lease recovery cancels a requested job regardless of heartbeat age', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    await beginUnit({
      jobId: id,
      stage: 'map',
      ordinal: 0,
      inputKey: 'key-a',
      payloadJson: '{}',
      now: 2_100,
    });
    await requestCancel(id, 2_200);

    const result = await recoverStaleJobs({ now: 2_300, mode: 'lease' });
    expect(result).toEqual({ recovered: 0, cancelled: 1 });
    expect((await getJob(id))?.status).toBe('cancelled');
    expect((await listJobUnits(id))[0].status).toBe('running');
  });

  it('finishJob does not clobber a cancelled job', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    await cancelJob(id, { now: 2_500 });
    await finishJob(id, 'done', { now: 2_600 });
    expect((await getJob(id))?.status).toBe('cancelled');
  });

  it('cancelJob records a terminal cancelled row', async () => {
    const id = await newJob();
    await claimJob(id, 2_000);
    await cancelJob(id, { now: 2_500 });
    const job = await getJob(id);
    expect(job?.status).toBe('cancelled');
    expect(job?.error).toBe('cancelled');
    expect(job?.finishedAt).toBe(2_500);
  });
});
