// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  createJob,
  createSession,
  getConverters,
  getJob,
  getTargets,
  startConvert,
  uploadFile,
} from './convertx.service';
import {
  POLL_INTERVAL_MS,
  SLOW_REQUEST_THRESHOLD_MS,
  STALL_TIMEOUT_MS,
  classifyJob,
  useConvertX,
} from './useConvertX';

vi.mock('./convertx.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./convertx.service')>();
  return {
    ...actual,
    checkHealth: vi.fn(),
    createSession: vi.fn(),
    getConverters: vi.fn(),
    getTargets: vi.fn(),
    createJob: vi.fn(),
    uploadFile: vi.fn(),
    startConvert: vi.fn(),
    getJob: vi.fn(),
  };
});

// Minimal composable test harness: mounts the composable inside a real component instance so
// onMounted/onUnmounted actually fire, without pulling in @vue/test-utils' rendering machinery.
function withSetup<T>(composable: () => T) {
  let result!: T;
  const app = createApp({
    setup() {
      result = composable();
      return () => null;
    },
  });
  app.mount(document.createElement('div'));
  let unmounted = false;
  return {
    result,
    unmount: () => {
      if (!unmounted) {
        unmounted = true;
        app.unmount();
      }
    },
  };
}

function makeFile(name: string) {
  return new File(['x'], name, { type: 'application/octet-stream' });
}

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

// Lets a chain of already-resolved mock promises (a few sequential `await`s deep) fully settle
// under real timers, without any real waiting: setTimeout(0) only runs after Node drains the
// entire microtask queue, which is exactly what unblocks e.g. init()'s
// checkHealth -> createSession -> getConverters chain.
async function flushRealMicrotasks() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

// Same idea for fake timers: advancing by 0 still runs sinon's tickAsync loop, which interleaves
// with the microtask queue. Called more than once so a multi-step await chain (e.g. convert()'s
// createJob -> uploadFile -> startConvert) has enough rounds to fully unwind.
async function flushFakeMicrotasks() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

describe('poll timings', () => {
  it('matches the upstream UI interval', () => {
    expect(POLL_INTERVAL_MS).toBe(1000);
  });

  it('uses a ten minute soft stall timeout', () => {
    expect(STALL_TIMEOUT_MS).toBe(600_000);
  });
});

describe('classifyJob', () => {
  it('is incomplete while fewer files have landed than expected', () => {
    expect(classifyJob({ status: 'completed', numFiles: 1, files: [] })).toEqual({ done: false });
  });

  it('is incomplete for a fresh job that has not been uploaded to yet', () => {
    // numFiles: 0, files: [] - the 0 === 0 trap. Must not read as vacuously "complete".
    expect(classifyJob({ status: 'pending', numFiles: 0, files: [] })).toEqual({ done: false });
  });

  it('reports success from the file status, not the job status', () => {
    const job = {
      status: 'pending',
      numFiles: 1,
      files: [{ fileName: 'a.png', outputFileName: 'a.jpg', status: 'Done' }],
    };
    expect(classifyJob(job)).toEqual({
      done: true,
      results: [{ name: 'a.jpg', failed: false, status: 'Done' }],
    });
  });

  it('reports failure even though the job reads completed', () => {
    const job = {
      status: 'completed',
      numFiles: 1,
      files: [{ fileName: 'a.xyz', outputFileName: 'a.jpg', status: 'Failed, check logs' }],
    };
    expect(classifyJob(job)).toEqual({
      done: true,
      results: [{ name: 'a.jpg', failed: true, status: 'Failed, check logs' }],
    });
  });

  it('treats job.status === "failed" as authoritative only while still incomplete', () => {
    const job = { status: 'failed', numFiles: 1, files: [] };
    expect(classifyJob(job)).toEqual({ done: true, failed: true, results: [] });
  });
});

describe('useConvertX boot sequence (init)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('goes to unavailable when the backend health check fails', async () => {
    vi.mocked(checkHealth).mockResolvedValue(false);

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();

    expect(result.state.value).toBe('unavailable');
    expect(createSession).not.toHaveBeenCalled();
    unmount();
  });

  it('goes to needs-account when session bootstrap fails', async () => {
    vi.mocked(checkHealth).mockResolvedValue(true);
    vi.mocked(createSession).mockRejectedValue(new Error('Could not start a session'));

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();

    expect(result.state.value).toBe('needs-account');
    expect(result.errorMessage.value).toBe('Could not start a session');
    unmount();
  });

  it('reaches ready with converters populated when every step succeeds', async () => {
    vi.mocked(checkHealth).mockResolvedValue(true);
    vi.mocked(createSession).mockResolvedValue(1);
    vi.mocked(getConverters).mockResolvedValue({ ffmpeg: ['jpg', 'webp'] });

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();

    expect(result.state.value).toBe('ready');
    expect(result.converters.value).toEqual({ ffmpeg: ['jpg', 'webp'] });
    unmount();
  });

  it('still reaches ready if getConverters fails, with an empty capability panel', async () => {
    vi.mocked(checkHealth).mockResolvedValue(true);
    vi.mocked(createSession).mockResolvedValue(1);
    vi.mocked(getConverters).mockRejectedValue(new Error('nope'));

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();

    expect(result.state.value).toBe('ready');
    expect(result.converters.value).toEqual({});
    unmount();
  });

  it('discards a getConverters() payload that resolves after reset() invalidates init()', async () => {
    vi.mocked(checkHealth).mockResolvedValue(true);
    vi.mocked(createSession).mockResolvedValue(1);
    const pendingConverters = deferred<Record<string, string[]>>();
    vi.mocked(getConverters).mockReturnValue(pendingConverters.promise);

    const { result, unmount } = withSetup(() => useConvertX());
    // Let checkHealth/createSession resolve so init() suspends on the still-pending getConverters().
    await flushRealMicrotasks();
    expect(result.state.value).toBe('probing');

    result.reset();
    expect(result.state.value).toBe('ready');

    // The abandoned init()'s getConverters() finally resolves, well after reset() moved on.
    pendingConverters.resolve({ ffmpeg: ['jpg'] });
    await flushRealMicrotasks();

    // Without checking the generation before assigning, this write would land unconditionally.
    expect(result.converters.value).toEqual({});
    expect(result.state.value).toBe('ready');
    unmount();
  });
});

describe('useConvertX selectFile', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(checkHealth).mockResolvedValue(true);
    vi.mocked(createSession).mockResolvedValue(1);
    vi.mocked(getConverters).mockResolvedValue({});
  });

  it('loads targets and returns to ready on success', async () => {
    vi.mocked(getTargets).mockResolvedValue({ ffmpeg: ['jpg'] });

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();

    await result.selectFile(makeFile('a.png'));

    expect(result.state.value).toBe('ready');
    expect(result.targets.value).toEqual({ ffmpeg: ['jpg'] });
    expect(getTargets).toHaveBeenCalledWith('png');
    unmount();
  });

  it('surfaces the service error message and goes to error on failure', async () => {
    vi.mocked(getTargets).mockRejectedValue(new Error('Could not reach the converter backend.'));

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();

    await result.selectFile(makeFile('a.png'));

    expect(result.state.value).toBe('error');
    expect(result.errorMessage.value).toBe('Could not reach the converter backend.');
    unmount();
  });
});

describe('useConvertX convert + poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.mocked(checkHealth).mockResolvedValue(true);
    vi.mocked(createSession).mockResolvedValue(1);
    vi.mocked(getConverters).mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function bootReady() {
    const harness = withSetup(() => useConvertX());
    await flushFakeMicrotasks();
    expect(harness.result.state.value).toBe('ready');
    return harness;
  }

  it('polls until the job completes, then reports per-file results', async () => {
    vi.mocked(createJob).mockResolvedValue(42);
    vi.mocked(uploadFile).mockResolvedValue(['stored-a.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    vi.mocked(getJob).mockResolvedValue({
      status: 'completed',
      numFiles: 1,
      files: [{ fileName: 'stored-a.png', outputFileName: 'a.jpg', status: 'Done' }],
    });

    const { result, unmount } = await bootReady();

    await result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    expect(result.state.value).toBe('converting');
    expect(result.jobId.value).toBe(42);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(result.state.value).toBe('done');
    expect(result.results.value).toEqual([{ name: 'a.jpg', failed: false, status: 'Done' }]);
    unmount();
  });

  it('creates a brand new job on every conversion (jobs are single-use)', async () => {
    vi.mocked(createJob).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    vi.mocked(getJob).mockResolvedValue({
      status: 'completed',
      numFiles: 1,
      files: [{ fileName: 'stored.png', outputFileName: 'a.jpg', status: 'Done' }],
    });

    const { result, unmount } = await bootReady();

    await result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(result.jobId.value).toBe(1);

    await result.convert(makeFile('b.png'), 'jpg', 'ffmpeg');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(result.jobId.value).toBe(2);

    expect(createJob).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('goes to error when the job dies at the job level before any file lands', async () => {
    vi.mocked(createJob).mockResolvedValue(1);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    vi.mocked(getJob).mockResolvedValue({ status: 'failed', numFiles: 1, files: [] });

    const { result, unmount } = await bootReady();

    await result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(result.state.value).toBe('error');
    expect(result.errorMessage.value).toBe('The conversion failed.');
    unmount();
  });

  it('goes to error immediately when starting the conversion itself fails, without polling', async () => {
    vi.mocked(createJob).mockRejectedValue(new Error('Could not reach the converter backend.'));

    const { result, unmount } = await bootReady();

    await result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');

    expect(result.state.value).toBe('error');
    expect(result.errorMessage.value).toBe('Could not reach the converter backend.');
    expect(getJob).not.toHaveBeenCalled();
    unmount();
  });

  it('soft-stalls after ten minutes of no completion, and keepWaiting resets the clock instead of re-tripping immediately', async () => {
    vi.mocked(createJob).mockResolvedValue(1);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    vi.mocked(getJob).mockResolvedValue({ status: 'pending', numFiles: 1, files: [] });

    const { result, unmount } = await bootReady();

    await result.convert(makeFile('big.mkv'), 'mp4', 'ffmpeg');

    // Push well past the ten minute soft timeout - a large video legitimately can take this long,
    // so this must land on 'stalled', never a hard error.
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 10_000);
    expect(result.state.value).toBe('stalled');
    expect(result.errorMessage.value).toBe('');
    // Polling must stop entirely while stalled - no leaked reschedule waiting to fire.
    expect(vi.getTimerCount()).toBe(0);

    result.keepWaiting();
    expect(result.state.value).toBe('converting');

    // If the stall clock were NOT reset to the keepWaiting() moment, this tick alone (long after
    // the original conversion start) would immediately re-trip the stall check.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.state.value).toBe('converting');

    // Now let it actually finish.
    vi.mocked(getJob).mockResolvedValue({
      status: 'completed',
      numFiles: 1,
      files: [{ fileName: 'stored.png', outputFileName: 'big.mp4', status: 'Done' }],
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(result.state.value).toBe('done');
    unmount();
  });

  it('does not resurrect a finished poll after the component unmounts mid-request', async () => {
    vi.mocked(createJob).mockResolvedValue(1);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    const pending = deferred<{ status: string; numFiles: number; files: { fileName: string; outputFileName: string; status: string }[] }>();
    vi.mocked(getJob).mockReturnValue(pending.promise);

    const { result, unmount } = await bootReady();

    await result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    // Fire the first poll tick; it calls getJob() and suspends on the still-pending promise.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getJob).toHaveBeenCalledTimes(1);

    unmount();

    // The in-flight request now resolves *after* unmount.
    pending.resolve({
      status: 'completed',
      numFiles: 1,
      files: [{ fileName: 'stored.png', outputFileName: 'a.jpg', status: 'Done' }],
    });
    await flushFakeMicrotasks();

    // Must not have written 'done' into state after the component is gone, and must not have
    // scheduled another poll.
    expect(result.state.value).toBe('converting');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards an in-flight poll result that resolves after reset()', async () => {
    vi.mocked(createJob).mockResolvedValue(1);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    const pending = deferred<{ status: string; numFiles: number; files: { fileName: string; outputFileName: string; status: string }[] }>();
    vi.mocked(getJob).mockReturnValue(pending.promise);

    const { result, unmount } = await bootReady();

    await result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getJob).toHaveBeenCalledTimes(1);

    result.reset();
    expect(result.state.value).toBe('ready');

    pending.resolve({
      status: 'completed',
      numFiles: 1,
      files: [{ fileName: 'stored.png', outputFileName: 'a.jpg', status: 'Done' }],
    });
    await flushFakeMicrotasks();

    // reset() must win: the stale poll from the discarded job must not overwrite it.
    expect(result.state.value).toBe('ready');
    expect(result.results.value).toEqual([]);
    unmount();
  });

  it('abandons a suspended poll when selectFile() picks a different file mid-conversion', async () => {
    vi.mocked(createJob).mockResolvedValue(1);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    const pendingJob = deferred<{ status: string; numFiles: number; files: { fileName: string; outputFileName: string; status: string }[] }>();
    vi.mocked(getJob).mockReturnValue(pendingJob.promise);
    vi.mocked(getTargets).mockResolvedValue({ ffmpeg: ['webp'] });

    const { result, unmount } = await bootReady();

    await result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    // Fire the first poll tick; it suspends on the still-pending getJob() response.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getJob).toHaveBeenCalledTimes(1);

    // The user picks a different file before the poll ever resolves.
    await result.selectFile(makeFile('b.png'));
    expect(result.state.value).toBe('ready');
    expect(result.jobId.value).toBeNull();

    // The abandoned job's poll finally resolves as completed, well after selectFile() moved on.
    pendingJob.resolve({
      status: 'completed',
      numFiles: 1,
      files: [{ fileName: 'stored.png', outputFileName: 'a.jpg', status: 'Done' }],
    });
    await flushFakeMicrotasks();

    // Without the generation re-check after this await, this write would land and clobber
    // selectFile()'s outcome back to 'done' with stale results.
    expect(result.state.value).toBe('ready');
    expect(result.results.value).toEqual([]);
    expect(result.targets.value).toEqual({ ffmpeg: ['webp'] });
    unmount();
  });

  it('abandons a suspended selectFile() when convert() starts before it resolves', async () => {
    const pendingTargets = deferred<Record<string, string[]>>();
    vi.mocked(getTargets).mockReturnValue(pendingTargets.promise);
    vi.mocked(createJob).mockResolvedValue(9);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    vi.mocked(getJob).mockResolvedValue({ status: 'pending', numFiles: 1, files: [] });

    const { result, unmount } = await bootReady();

    // Started but deliberately not awaited: it suspends on the still-pending getTargets().
    const selecting = result.selectFile(makeFile('a.png'));
    expect(result.state.value).toBe('loading-targets');

    // The user starts converting a different file before target-loading ever resolves.
    await result.convert(makeFile('b.png'), 'jpg', 'ffmpeg');
    expect(result.state.value).toBe('converting');
    expect(result.jobId.value).toBe(9);

    // The abandoned selectFile() finally resolves, well after convert() moved on.
    pendingTargets.resolve({ ffmpeg: ['jpg'] });
    await flushFakeMicrotasks();
    await selecting;

    // Without the generation re-check after this await, this write would land and clobber
    // convert()'s 'converting' state back to 'ready'.
    expect(result.state.value).toBe('converting');
    expect(result.jobId.value).toBe(9);
    unmount();
  });

  it('flips isSlow on past the threshold during a genuinely slow request, and off once it settles', async () => {
    const pendingCreateJob = deferred<number>();
    vi.mocked(createJob).mockReturnValue(pendingCreateJob.promise);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    vi.mocked(getJob).mockResolvedValue({ status: 'pending', numFiles: 1, files: [] });

    const { result, unmount } = await bootReady();

    const converting = result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    expect(result.isSlow.value).toBe(false);

    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_THRESHOLD_MS);
    expect(result.isSlow.value).toBe(true);

    pendingCreateJob.resolve(1);
    await flushFakeMicrotasks();
    await converting;

    expect(result.isSlow.value).toBe(false);
    unmount();
  });

  it('does not flip isSlow back on for a request abandoned by reset() before it settles', async () => {
    const pendingCreateJob = deferred<number>();
    vi.mocked(createJob).mockReturnValue(pendingCreateJob.promise);

    const { result, unmount } = await bootReady();

    void result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    expect(result.state.value).toBe('converting');

    // Abandon the request well before the slow-indicator threshold trips.
    result.reset();
    expect(result.state.value).toBe('ready');
    expect(result.isSlow.value).toBe(false);

    // Advance past the threshold: the orphaned timer fires, but must not resurrect `isSlow`
    // for a request nothing is showing as "in flight" any more.
    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_THRESHOLD_MS);
    expect(result.isSlow.value).toBe(false);
    expect(result.state.value).toBe('ready');

    // Let the orphan actually settle too - still must not disturb anything.
    pendingCreateJob.resolve(1);
    await flushFakeMicrotasks();
    expect(result.isSlow.value).toBe(false);
    expect(result.state.value).toBe('ready');
    unmount();
  });

  it('clears a stale isSlow immediately when re-invoked, before the new call could itself be slow', async () => {
    const firstCreateJob = deferred<number>();
    vi.mocked(createJob).mockReturnValueOnce(firstCreateJob.promise);
    vi.mocked(uploadFile).mockResolvedValue(['stored.png']);
    vi.mocked(startConvert).mockResolvedValue(undefined);
    vi.mocked(getJob).mockResolvedValue({ status: 'pending', numFiles: 1, files: [] });

    const { result, unmount } = await bootReady();

    void result.convert(makeFile('a.png'), 'jpg', 'ffmpeg');
    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_THRESHOLD_MS);
    expect(result.isSlow.value).toBe(true);

    // Re-invoke directly - no reset() in between - with a fast second createJob().
    vi.mocked(createJob).mockResolvedValueOnce(2);
    const second = result.convert(makeFile('b.png'), 'jpg', 'ffmpeg');

    // Must already be false on entry to the new operation, before it has had any chance to be
    // slow itself - not one microtask later once its own withSlowIndicator() settles.
    expect(result.isSlow.value).toBe(false);

    await second;
    expect(result.isSlow.value).toBe(false);

    // The first (abandoned) call's orphaned createJob() finally settles too - must not resurrect it.
    firstCreateJob.resolve(1);
    await flushFakeMicrotasks();
    expect(result.isSlow.value).toBe(false);
    unmount();
  });
});

describe('useConvertX reset() and terminal backend states', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does not paper over an unreachable backend', async () => {
    vi.mocked(checkHealth).mockResolvedValue(false);

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();
    expect(result.state.value).toBe('unavailable');

    result.reset();

    expect(result.state.value).toBe('unavailable');
    unmount();
  });

  it('does not paper over a missing session', async () => {
    vi.mocked(checkHealth).mockResolvedValue(true);
    vi.mocked(createSession).mockRejectedValue(new Error('Could not start a session'));

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();
    expect(result.state.value).toBe('needs-account');

    result.reset();

    expect(result.state.value).toBe('needs-account');
    unmount();
  });

  it('still returns to ready from an ordinary error state', async () => {
    vi.mocked(checkHealth).mockResolvedValue(true);
    vi.mocked(createSession).mockResolvedValue(1);
    vi.mocked(getConverters).mockResolvedValue({});
    vi.mocked(getTargets).mockRejectedValue(new Error('boom'));

    const { result, unmount } = withSetup(() => useConvertX());
    await flushRealMicrotasks();

    await result.selectFile(makeFile('a.png'));
    expect(result.state.value).toBe('error');

    result.reset();

    expect(result.state.value).toBe('ready');
    unmount();
  });
});
