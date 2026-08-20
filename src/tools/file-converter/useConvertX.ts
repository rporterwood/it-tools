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

// Threshold for the "still trying..." indication (see `withSlowIndicator` below). Exported
// (rather than kept private) so tests can assert against it instead of hard-coding the number.
export const SLOW_REQUEST_THRESHOLD_MS = 3_000;

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

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
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

  // Bumped on entry to EVERY user-initiated operation - init(), selectFile(), convert(), reset(),
  // and unmount - not just polling. Each operation captures the generation it started with; every
  // await inside it re-checks that capture against the live counter before writing state or
  // scheduling anything further. This makes the invariant symmetric: any newer operation
  // invalidates every older one, in both directions.
  //
  // This used to be scoped to polling only ("pollGeneration"), which left selectFile() and init()
  // outside the scheme entirely. That allowed real, user-triggerable corruption in both
  // directions: a poll suspended in getJob() could resolve after a later selectFile() and
  // overwrite it back to 'done' with stale results; symmetrically, a selectFile() suspended in
  // getTargets() could resolve after a later convert() and overwrite 'converting' back to
  // 'ready'. Scoping the counter to every operation (not just polling) closes both directions.
  let operationGeneration = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingSince = 0;
  // Set once, on unmount, and never cleared - the composable instance is done for good at that
  // point, unlike operationGeneration which is expected to change repeatedly across the
  // instance's life.
  let unmounted = false;

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // Stops any pending poll timer AND invalidates every in-flight operation (a poll already past
  // its `await getJob()`, a selectFile() past its `await getTargets()`, a convert() mid-chain,
  // ...), so each one's eventual resolution becomes a no-op instead of clobbering whatever state
  // comes next. Returns the new generation for the caller to capture.
  //
  // Also zeroes `isSlow` here, not just in reset(): every operation starts this way, so a stale
  // `true` left by a prior operation's abandoned request (its own timer callback is gated on the
  // generation it captured, but the ref itself has no memory of "whose" true it's showing) can
  // never bleed into the start of the next operation - including re-invoking the same operation
  // (e.g. calling convert() again without an intervening reset()) and unmount, which previously
  // left a hung call's timer able to leave `isSlow` true forever on a now-discarded ref.
  function invalidate(): number {
    stopPolling();
    operationGeneration += 1;
    isSlow.value = false;
    return operationGeneration;
  }

  // Wraps a request so a component can show a "still trying..." message for a slow-but-legitimate
  // call without this layer ever cancelling it. Task 7 left the worst case of a fully-expired
  // session against a slow backend at roughly 90s across three independently-bounded stages
  // (original call, session re-bootstrap, retried call) deliberately un-bounded here, since a
  // cross-cutting deadline would be blunt enough to abort genuinely slow-but-healthy work. This
  // only ever flips a flag after a threshold; it never aborts or races the underlying promise.
  //
  // Both the timer callback and the `finally` are gated on the same generation check the caller
  // uses everywhere else. Without that gate, a request abandoned by reset()/a newer operation
  // (e.g. a createJob() that never resolves, discarded by reset()) would still flip `isSlow` back
  // to true off its orphaned timer once the threshold passed - a "still trying..." message with
  // nothing actually in flight, self-correcting only whenever the orphan eventually settles.
  async function withSlowIndicator<T>(generation: number, fn: () => Promise<T>): Promise<T> {
    const isCurrent = () => !unmounted && generation === operationGeneration;

    const timer = setTimeout(() => {
      if (isCurrent()) {
        isSlow.value = true;
      }
    }, SLOW_REQUEST_THRESHOLD_MS);

    try {
      return await fn();
    }
    finally {
      clearTimeout(timer);
      if (isCurrent()) {
        isSlow.value = false;
      }
    }
  }

  async function init() {
    const generation = invalidate();

    state.value = 'probing';
    errorMessage.value = '';

    const healthy = await withSlowIndicator(generation, () => checkHealth());
    if (unmounted || generation !== operationGeneration) {
      return;
    }
    if (!healthy) {
      state.value = 'unavailable';
      return;
    }

    try {
      await withSlowIndicator(generation, () => createSession());
    }
    catch (error) {
      if (unmounted || generation !== operationGeneration) {
        return;
      }
      errorMessage.value = errorMessageOf(error);
      state.value = 'needs-account';
      return;
    }
    if (unmounted || generation !== operationGeneration) {
      return;
    }

    const foundConverters = await withSlowIndicator(generation, () => getConverters()).catch(() => ({}));
    if (unmounted || generation !== operationGeneration) {
      return;
    }
    converters.value = foundConverters;
    state.value = 'ready';
  }

  async function selectFile(file: File) {
    const generation = invalidate();

    state.value = 'loading-targets';
    errorMessage.value = '';
    results.value = [];
    jobId.value = null;

    const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : '';

    try {
      const found = await withSlowIndicator(generation, () => getTargets(extension));
      if (unmounted || generation !== operationGeneration) {
        return;
      }
      targets.value = found;
      state.value = 'ready';
    }
    catch (error) {
      if (unmounted || generation !== operationGeneration) {
        return;
      }
      errorMessage.value = errorMessageOf(error);
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

    if (unmounted || generation !== operationGeneration || jobId.value === null) {
      return;
    }

    try {
      const job = await getJob(jobId.value);

      // The generation (or unmounted flag) may have changed while getJob() was in flight -
      // e.g. reset(), selectFile(), or a fresh convert() ran during the await. Discard a stale
      // result rather than let it overwrite newer state.
      if (unmounted || generation !== operationGeneration) {
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
      if (unmounted || generation !== operationGeneration) {
        return;
      }
      errorMessage.value = errorMessageOf(error);
      state.value = 'error';
    }
  }

  function keepWaiting() {
    if (unmounted || state.value !== 'stalled') {
      return;
    }
    // Reset the stall clock to the moment the user agreed to keep waiting, not the original
    // conversion start - otherwise the very next poll would immediately re-trip the stall check.
    // Deliberately does NOT call invalidate(): this continues the same operation convert()
    // started, it does not begin a new one.
    waitingSince = Date.now();
    state.value = 'converting';
    schedulePoll(operationGeneration);
  }

  async function convert(file: File, target: string, converter: string) {
    // Jobs are single-use: a fresh createJob() is required for every conversion, and any prior
    // operation (a poll, a still-loading selectFile(), a previous convert()) must be invalidated
    // so it can never resolve into this one's state.
    const generation = invalidate();

    state.value = 'converting';
    errorMessage.value = '';
    results.value = [];
    jobId.value = null;

    try {
      const newJobId = await withSlowIndicator(generation, () => createJob());
      if (unmounted || generation !== operationGeneration) {
        return;
      }
      jobId.value = newJobId;

      const storedNames = await withSlowIndicator(generation, () => uploadFile(newJobId, file));
      if (unmounted || generation !== operationGeneration) {
        return;
      }

      await withSlowIndicator(generation, () => startConvert(newJobId, target, converter, storedNames));
      if (unmounted || generation !== operationGeneration) {
        return;
      }

      waitingSince = Date.now();
      schedulePoll(generation);
    }
    catch (error) {
      if (unmounted || generation !== operationGeneration) {
        return;
      }
      errorMessage.value = errorMessageOf(error);
      state.value = 'error';
    }
  }

  function reset() {
    // invalidate() also zeroes isSlow.
    invalidate();
    jobId.value = null;
    results.value = [];
    targets.value = {};
    errorMessage.value = '';

    // Preserve terminal backend-availability states rather than trusting a future caller not to
    // invoke reset() from them: jumping straight to 'ready' would present a working file picker
    // against a backend that is down (`unavailable`) or session-less (`needs-account`), with no
    // path back to init(). Every other state is safe to fold back to 'ready'.
    if (state.value !== 'unavailable' && state.value !== 'needs-account') {
      state.value = 'ready';
    }
  }

  onMounted(init);
  onUnmounted(() => {
    unmounted = true;
    invalidate();
  });

  return { state, targets, converters, results, errorMessage, jobId, isSlow, selectFile, convert, reset, keepWaiting };
}
