import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, createSession, downloadFile, getTargets, isFailureStatus, uploadFile } from './convertx.service';

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

// A fetch that never resolves on its own - it only settles (with an AbortError) if the caller's
// AbortSignal fires. Used to prove timeout behavior without waiting in real time.
function hangingFetch() {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    });
  }));
}

describe('isFailureStatus', () => {
  it('treats the two known failure strings as failures', () => {
    expect(isFailureStatus('Failed, check logs')).toBe(true);
    expect(isFailureStatus('File type not supported')).toBe(true);
  });

  it('treats every other status as success', () => {
    expect(isFailureStatus('Done')).toBe(false);
    expect(isFailureStatus('Done: resized to 256x256')).toBe(false);
    expect(isFailureStatus('/app/data/output/1/1/x.eml')).toBe(false);
  });
});

describe('getTargets', () => {
  it('returns the parsed body', async () => {
    vi.stubGlobal('fetch', mockFetch({ ffmpeg: ['jpg', 'webp'] }));
    await expect(getTargets('png')).resolves.toEqual({ ffmpeg: ['jpg', 'webp'] });
  });

  it('throws the envelope message on an error response', async () => {
    vi.stubGlobal('fetch', mockFetch({ success: false, message: 'Unauthorized' }, 401));
    await expect(getTargets('png')).rejects.toThrow('Unauthorized');
  });
});

describe('uploadFile', () => {
  it('returns the server-side stored names, not the local one', async () => {
    vi.stubGlobal('fetch', mockFetch({ files: [{ name: 'safe.txt' }] }));
    const file = new File(['x'], '../evil.txt', { type: 'text/plain' });
    await expect(uploadFile(1, file)).resolves.toEqual(['safe.txt']);
  });
});

describe('session retry on 401/422', () => {
  it('re-bootstraps a session and retries once on 401, then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ success: false, message: 'Unauthorized' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ userId: 1 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ffmpeg: ['jpg'] }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getTargets('png')).resolves.toEqual({ ffmpeg: ['jpg'] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toContain('/session');
  });

  it('re-bootstraps a session and retries once on 422 (no cookie at all), then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ success: false, message: 'Validation error' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ userId: 1 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ffmpeg: ['jpg'] }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getTargets('png')).resolves.toEqual({ ffmpeg: ['jpg'] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry forever when the session refresh still comes back unauthorized', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ success: false, message: 'Unauthorized' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ userId: 1 }) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ success: false, message: 'Still unauthorized' }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getTargets('png')).rejects.toThrow('Still unauthorized');
    // One failed attempt + one session bootstrap + one retried attempt = exactly 3 calls,
    // proving the retry does not recurse a second time.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('checkHealth', () => {
  it('returns true when the API responds with the expected healthcheck body', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 'ok' }));
    await expect(checkHealth()).resolves.toBe(true);
  });

  it('returns false when the response is a 200 that is not the healthcheck shape (SPA shell served instead of the API)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }));
    await expect(checkHealth()).resolves.toBe(false);
  });

  it('returns false on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(checkHealth()).resolves.toBe(false);
  });
});

describe('downloadFile', () => {
  it('resolves with the blob on success', async () => {
    const blob = new Blob(['data']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => blob }));
    await expect(downloadFile(1, 'out.png')).resolves.toBe(blob);
  });

  it('encodes the file name path segment', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob() });
    vi.stubGlobal('fetch', fetchMock);

    await downloadFile(1, 'a b/c.png');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('a b/c.png')),
      expect.anything(),
    );
  });

  it('throws "expired" on a 404 (file cleaned up after ~24h)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => null }));
    await expect(downloadFile(1, 'out.png')).rejects.toThrow('expired');
  });

  it('throws a generic download error on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => null }));
    await expect(downloadFile(1, 'out.png')).rejects.toThrow('Download failed');
  });

  it('re-bootstraps the session and retries on 401 before downloading', async () => {
    const blob = new Blob(['data']);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ success: false, message: 'Unauthorized' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ userId: 1 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => blob });
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadFile(1, 'out.png')).resolves.toBe(blob);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('unreadable success responses (SPA shell served instead of the API)', () => {
  it('request()-backed calls throw a friendly error instead of a raw SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }));

    await expect(getTargets('png')).rejects.toThrow('The converter backend returned an unreadable response.');
    await expect(getTargets('png')).rejects.not.toThrow(SyntaxError);
  });

  it('createSession() throws a friendly error instead of a raw SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }));

    await expect(createSession()).rejects.toThrow('The converter backend returned an unreadable response.');
    await expect(createSession()).rejects.not.toThrow(SyntaxError);
  });
});

describe('network failures (offline, DNS, CORS)', () => {
  it('translates a raw fetch TypeError into a friendly "could not reach" error on a JSON call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(getTargets('png')).rejects.toThrow('Could not reach the converter backend.');
    await expect(getTargets('png')).rejects.not.toThrow(TypeError);
  });

  it('translates the same TypeError on the no-timeout download/upload path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(downloadFile(1, 'out.png')).rejects.toThrow('Could not reach the converter backend.');
  });

  it('stays distinguishable from the timeout and unreadable-response messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const networkMessage = await getTargets('png').catch((error: Error) => error.message);

    expect(networkMessage).toBe('Could not reach the converter backend.');
    expect(networkMessage).not.toContain('did not respond in time');
    expect(networkMessage).not.toContain('unreadable response');
  });
});

describe('timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checkHealth() returns false on timeout rather than hanging or throwing', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const result = checkHealth();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe(false);
  });

  it('a JSON call that exceeds its 30s budget surfaces a friendly timeout error, not a raw AbortError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const result = getTargets('png');
    const assertion = expect(result).rejects.toThrow('The converter backend did not respond in time.');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DOMException);
    });
  });

  it('uploadFile has no client timeout and is not aborted by the 30s JSON budget', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['x'], 'big.bin');
    const result = uploadFile(1, file);

    // Advance well past the 30s JSON budget - a slow-but-healthy upload must not be cancelled.
    await vi.advanceTimersByTimeAsync(35_000);
    expect((fetchMock.mock.calls[0][1] as RequestInit)?.signal).toBeUndefined();

    resolveFetch({ ok: true, status: 200, json: async () => ({ files: [{ name: 'big.bin' }] }) });
    await expect(result).resolves.toEqual(['big.bin']);
  });

  it('downloadFile has no client timeout and is not aborted by the 30s JSON budget', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const blob = new Blob(['data']);
    const result = downloadFile(1, 'out.png');

    await vi.advanceTimersByTimeAsync(35_000);
    expect((fetchMock.mock.calls[0][1] as RequestInit)?.signal).toBeUndefined();

    resolveFetch({ ok: true, status: 200, blob: async () => blob });
    await expect(result).resolves.toBe(blob);
  });

  it('the retried attempt gets a fresh timeout budget instead of sharing the original clock', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn()
      // Initial attempt: fails fast with 401 (not a timeout).
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ success: false, message: 'Unauthorized' }) })
      // Session bootstrap takes 25s - within its own fresh 30s budget.
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ userId: 1 }) }), 25_000);
      }))
      // Retried attempt takes another 25s. Total elapsed (50s) would blow a single 30s budget
      // shared from the original request's start; it only succeeds because it gets its own
      // fresh 30s budget starting when the retry itself begins.
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ ffmpeg: ['jpg'] }) }), 25_000);
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = getTargets('png');
    await vi.advanceTimersByTimeAsync(50_000);

    await expect(result).resolves.toEqual({ ffmpeg: ['jpg'] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
