import {
  type JobStatus,
  checkHealth,
  createJob,
  createSession,
  getConverters,
  getJob,
  getTargets,
  isFailureStatus,
  startConvert,
  uploadFile,
} from './convertx.service';

export const POLL_INTERVAL_MS = 1000;
export const STALL_TIMEOUT_MS = 600_000;

// Not part of the required exports, but used to gate the "still trying..." indication
// described below. Kept small and separate from POLL/STALL so it can move independently.
const SLOW_REQUEST_THRESHOLD_MS = 3_000;

export type ConvertState =
  | 'probing'
  | 'unavailable'
  | 'needs-account'
  | 'ready'
  | 'loading-targets'
  | 'converting'
  | 'stalled'
  | 'done'
  | 'error';

export interface ConvertResult {
  name: string
  failed: boolean
  status: string
}

interface JobClassification {
  done: boolean
  failed?: boolean
  results?: ConvertResult[]
}

// Classifies a job's poll response into "still working" / "dead" / "finished with per-file
// results". The ordering here is load-bearing, not a style choice:
//
// 1. Completeness (all expected files have landed a row) is checked FIRST. handleConvert on the
//    server chunks its work per file, so a job can be marked 'failed' by one chunk's failure while
//    sibling files still land successful rows. Checking job.status === 'failed' before
//    completeness would hide those real, downloadable results.
// 2. Only once we know the job is INCOMPLETE does job.status get consulted, and only for the one
//    value it is trustworthy for: 'failed'. That is the one signal that the background chain died
//    before producing any more rows - without surfacing it, the client polls all the way to the
//    stall timeout reporting "still working" about a job that is already dead and, being
//    single-use, unretryable.
// 3. Every other status value (including 'completed', which the API writes unconditionally in
//    its .then() handler even when every single file failed) is never consulted - completion is
//    determined solely by `files.length === numFiles`.
//
// A fresh job (just created, nothing uploaded/converted yet) has numFiles: 0 and files: []. The
// `numFiles > 0` guard below is required so that case reads as "not complete" rather than
// vacuously "complete because 0 === 0" - without it, a job that hasn't even started would
// immediately classify as done with an empty result set.
export function classifyJob(job: JobStatus): JobClassification {
  const complete = job.numFiles > 0 && job.files.length === job.numFiles;

  if (!complete) {
    if (job.status === 'failed') {
      return { done: true, failed: true, results: [] };
    }
    return { done: false };
  }

  return {
    done: true,
    results: job.files.map(file => ({
      name: file.outputFileName,
      failed: isFailureStatus(file.status),
      status: file.status,
    })),
  };
}

export function useConvertX() {
  const state = ref<ConvertState>('probing');
  const targets = ref<Record<string, string[]>>({});
  const converters = ref<Record<string, string[]>>({});
  const results = ref<ConvertResult[]>([]);
  const errorMessage = ref('');
  const jobId = ref<number | null>(null);
  // Exposed so a component can render a "still trying..." affordance for a long-but-legitimate
  // single request (session bootstrap + retry can legitimately take ~90s worst case - see the
  // comment on `withSlowIndicator` below) without this layer imposing a hard deadline that could
  // cancel real work.
  const isSlow = ref(false);

  // Bumped by reset()/unmount()/every new convert() call. Any in-flight poll (i.e. one already
  // past its `await getJob(...)`) captured the generation it was scheduled under; if that number
  // no longer matches by the time the await resolves, the poll's result is stale and must be
  // discarded rather than allowed to overwrite fresher state (e.g. a reset() or a brand new
  // convert() that happened while the network call was in flight).
  let pollGeneration = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingSince = 0;
  // Set once, on unmount, and never cleared - the composable instance is done for good at that
  // point, unlike pollGeneration which is expected to change repeatedly across the instance's
  // life.
  let unmounted = false;

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // Stops any pending timer AND invalidates any poll already in flight (awaiting getJob()), so
  // its eventual resolution becomes a no-op instead of clobbering whatever state comes next.
  function invalidatePolling() {
    stopPolling();
    pollGeneration += 1;
  }

  // Wraps a request so a component can show a "still trying..." message for a slow-but-legitimate
  // call without this layer ever cancelling it. Task 7 left the worst case of a fully-expired
  // session against a slow backend at roughly 90s across three independently-bounded stages
  // (original call, session re-bootstrap, retried call) deliberately un-bounded here, since a
  // cross-cutting deadline would be blunt enough to abort genuinely slow-but-healthy work. This
  // only ever flips a flag after a threshold; it never aborts or races the underlying promise.
  async function withSlowIndicator<T>(fn: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      isSlow.value = true;
    }, SLOW_REQUEST_THRESHOLD_MS);

    try {
      return await fn();
    }
    finally {
      clearTimeout(timer);
      isSlow.value = false;
    }
  }

  async function init() {
    state.value = 'probing';
    errorMessage.value = '';

    const healthy = await withSlowIndicator(() => checkHealth());
    if (unmounted) {
      return;
    }
    if (!healthy) {
      state.value = 'unavailable';
      return;
    }

    try {
      await withSlowIndicator(() => createSession());
    }
    catch (error) {
      if (unmounted) {
        return;
      }
      errorMessage.value = (error as Error).message;
      state.value = 'needs-account';
      return;
    }
    if (unmounted) {
      return;
    }

    converters.value = await withSlowIndicator(() => getConverters()).catch(() => ({}));
    if (unmounted) {
      return;
    }
    state.value = 'ready';
  }

  async function selectFile(file: File) {
    state.value = 'loading-targets';
    errorMessage.value = '';
    results.value = [];
    jobId.value = null;

    const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : '';

    try {
      const found = await withSlowIndicator(() => getTargets(extension));
      if (unmounted) {
        return;
      }
      targets.value = found;
      state.value = 'ready';
    }
    catch (error) {
      if (unmounted) {
        return;
      }
      errorMessage.value = (error as Error).message;
      state.value = 'error';
    }
  }

  function schedulePoll(generation: number) {
    stopPolling();
    pollTimer = setTimeout(() => {
      void runPoll(generation);
    }, POLL_INTERVAL_MS);
  }

  async function runPoll(generation: number) {
    pollTimer = null;

    if (unmounted || generation !== pollGeneration || jobId.value === null) {
      return;
    }

    try {
      const job = await getJob(jobId.value);

      // The generation (or unmounted flag) may have changed while getJob() was in flight -
      // e.g. reset() or a fresh convert() ran during the await. Discard a stale result rather
      // than let it overwrite newer state.
      if (unmounted || generation !== pollGeneration) {
        return;
      }

      const classification = classifyJob(job);

      if (classification.done) {
        if (classification.failed) {
          errorMessage.value = 'The conversion failed.';
          state.value = 'error';
        }
        else {
          results.value = classification.results ?? [];
          state.value = 'done';
        }
        return;
      }

      if (Date.now() - waitingSince > STALL_TIMEOUT_MS) {
        // Soft timeout only: stop polling and let the user decide via keepWaiting(). A single-
        // file job has zero file_names rows until it finishes, so "stalled" and "just slow" are
        // observationally identical here - a large video or a LaTeX document can legitimately
        // take this long. Never hard-fail the job for taking a while.
        state.value = 'stalled';
        return;
      }

      schedulePoll(generation);
    }
    catch (error) {
      if (unmounted || generation !== pollGeneration) {
        return;
      }
      errorMessage.value = (error as Error).message;
      state.value = 'error';
    }
  }

  function keepWaiting() {
    if (unmounted || state.value !== 'stalled') {
      return;
    }
    // Reset the stall clock to the moment the user agreed to keep waiting, not the original
    // conversion start - otherwise the very next poll would immediately re-trip the stall check.
    waitingSince = Date.now();
    state.value = 'converting';
    schedulePoll(pollGeneration);
  }

  async function convert(file: File, target: string, converter: string) {
    // Jobs are single-use: a fresh createJob() is required for every conversion, and any poll
    // left over from a previous conversion must be invalidated so it can never resolve into this
    // one's state.
    invalidatePolling();
    const generation = pollGeneration;

    state.value = 'converting';
    errorMessage.value = '';
    results.value = [];
    jobId.value = null;

    try {
      const newJobId = await withSlowIndicator(() => createJob());
      if (unmounted || generation !== pollGeneration) {
        return;
      }
      jobId.value = newJobId;

      const storedNames = await withSlowIndicator(() => uploadFile(newJobId, file));
      if (unmounted || generation !== pollGeneration) {
        return;
      }

      await withSlowIndicator(() => startConvert(newJobId, target, converter, storedNames));
      if (unmounted || generation !== pollGeneration) {
        return;
      }

      waitingSince = Date.now();
      schedulePoll(generation);
    }
    catch (error) {
      if (unmounted || generation !== pollGeneration) {
        return;
      }
      errorMessage.value = (error as Error).message;
      state.value = 'error';
    }
  }

  function reset() {
    invalidatePolling();
    jobId.value = null;
    results.value = [];
    targets.value = {};
    errorMessage.value = '';
    isSlow.value = false;
    state.value = 'ready';
  }

  onMounted(init);
  onUnmounted(() => {
    unmounted = true;
    invalidatePolling();
  });

  return { state, targets, converters, results, errorMessage, jobId, isSlow, selectFile, convert, reset, keepWaiting };
}
