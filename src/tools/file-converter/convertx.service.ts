import { config } from '@/config';

const BASE = config.app.convertxUrl;

const FAILURE_STATUSES = ['Failed, check logs', 'File type not supported'];

// Per-call timeout budgets - a single global value cannot serve all of these correctly:
// - checkHealth() runs on mount and gates the "backend not reachable" state, so it must fail
//   fast rather than leave the user staring at a spinner.
// - The JSON endpoints are small and quick; 30s is generous headroom without being so long
//   that a hung backend reads as a frozen UI.
// - uploadFile/downloadFile are bandwidth-bound and legitimately slow (nginx permits 2GB
//   uploads) and are deliberately given NO client timeout - aborting a healthy multi-minute
//   transfer would be worse than the hang it's meant to prevent. nginx and the browser already
//   bound them. Do not "simplify" these three into one shared constant.
const HEALTH_TIMEOUT_MS = 5_000;
const JSON_TIMEOUT_MS = 30_000;

export interface ConvertXError {
  success: false
  message: string
}

export interface JobStatus {
  status: string
  numFiles: number
  files: { fileName: string; outputFileName: string; status: string }[]
}

export function isFailureStatus(status: string): boolean {
  return FAILURE_STATUSES.includes(status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

// Wraps `fetch` with an optional abort-on-timeout budget. `timeoutMs === null` means "no
// timeout" (used by uploadFile/downloadFile). A raw abort throws a `DOMException` named
// `AbortError`, which is not something a component should ever have to special-case, so it is
// translated here into a plain, user-presentable `Error` - the one place that translation needs
// to happen. The timer is always cleared, on both the success and failure paths, so a request
// that finishes before its budget never leaks a pending timer.
async function timedFetch(path: string, init: RequestInit, timeoutMs: number | null): Promise<Response> {
  if (timeoutMs === null) {
    return await fetch(`${BASE}${path}`, { ...init, credentials: 'same-origin' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${BASE}${path}`, { ...init, credentials: 'same-origin', signal: controller.signal });
  }
  catch (error) {
    if (isAbortError(error)) {
      throw new Error('The converter backend did not respond in time.');
    }
    throw error;
  }
  finally {
    clearTimeout(timer);
  }
}

export async function createSession(): Promise<number> {
  const response = await timedFetch('/session', { method: 'POST' }, JSON_TIMEOUT_MS);

  if (!response.ok) {
    const body = await response.json().catch(() => null) as ConvertXError | null;
    throw new Error(body?.message ?? 'Could not start a session');
  }

  const { userId } = await response.json() as { userId: number };
  return userId;
}

// Shared by every authenticated endpoint (JSON or binary). 401 = a cookie is present but
// invalid/expired. 422 = NO cookie at all: upstream's `auth` macro binds `cookie: "session"`,
// whose schema declares `auth` as a REQUIRED string, so a cookie-less request fails Elysia's
// schema validation before resolve() ever runs. Both mean "no usable session" and both must
// trigger a re-bootstrap - retrying only on 401 leaves a user who cleared their cookies stuck
// on a hard error. `retry` flips to false on the retried call, so this can recurse at most once.
//
// Timeout/retry interaction: each call to `timedFetch` (the original attempt, `createSession`,
// and the retried attempt) gets its OWN fresh timeout budget rather than sharing one clock. A
// slow session bootstrap should not eat into the retried request's budget, and a timeout abort
// surfaces as a thrown Error from `timedFetch` before a `Response`/status code ever exists, so
// it can never be mistaken for a retryable 401/422 - it just propagates straight out.
async function fetchWithRetry(
  path: string,
  init: RequestInit,
  timeoutMs: number | null,
  retry = true,
): Promise<Response> {
  const response = await timedFetch(path, init, timeoutMs);

  if ((response.status === 401 || response.status === 422) && retry) {
    await createSession();
    return fetchWithRetry(path, init, timeoutMs, false);
  }

  return response;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs: number | null = JSON_TIMEOUT_MS): Promise<T> {
  const response = await fetchWithRetry(path, init, timeoutMs);

  if (!response.ok) {
    const body = await response.json().catch(() => null) as ConvertXError | null;
    throw new Error(body?.message ?? `Request failed with status ${response.status}`);
  }

  return await response.json() as T;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await timedFetch('/healthcheck', {}, HEALTH_TIMEOUT_MS);
    if (!response.ok) {
      return false;
    }
    // A 200 whose body isn't the expected shape means nginx served the SPA shell instead of
    // proxying to the API - that must not read as "backend reachable".
    const body = await response.json().catch(() => null) as { status?: string } | null;
    return body?.status === 'ok';
  }
  catch {
    // Covers both a network error and the timeout-derived Error thrown by timedFetch.
    return false;
  }
}

export async function getConverters(): Promise<Record<string, string[]>> {
  return await request<Record<string, string[]>>('/converters');
}

export async function getTargets(fileType: string): Promise<Record<string, string[]>> {
  return await request<Record<string, string[]>>('/targets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileType }),
  });
}

export async function createJob(): Promise<number> {
  const { jobId } = await request<{ jobId: number }>('/jobs', { method: 'POST' });
  return jobId;
}

export async function uploadFile(jobId: number, file: File): Promise<string[]> {
  const form = new FormData();
  form.append('file', file);

  // No timeout: uploads are bandwidth-bound, not hang-bound. See the constants comment above.
  const { files } = await request<{ files: { name: string }[] }>(
    `/jobs/${jobId}/files`,
    { method: 'POST', body: form },
    null,
  );

  return files.map(({ name }) => name);
}

export async function startConvert(
  jobId: number,
  target: string,
  converter: string,
  fileNames: string[],
): Promise<void> {
  await request(`/jobs/${jobId}/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, converter, fileNames }),
  });
}

export async function getJob(jobId: number): Promise<JobStatus> {
  return await request<JobStatus>(`/jobs/${jobId}`);
}

export async function downloadFile(jobId: number, name: string): Promise<Blob> {
  // GET /jobs/:id/files/:name is an authenticated route too, so it needs the same 401/422
  // retry as every other endpoint - the original draft used a bare `fetch` here and silently
  // dropped that behavior for downloads specifically. No timeout: downloads are bandwidth-bound,
  // not hang-bound. See the constants comment above.
  const response = await fetchWithRetry(`/jobs/${jobId}/files/${encodeURIComponent(name)}`, {}, null);

  if (!response.ok) {
    throw new Error(response.status === 404 ? 'expired' : 'Download failed');
  }

  return await response.blob();
}
