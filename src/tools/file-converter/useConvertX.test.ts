// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
