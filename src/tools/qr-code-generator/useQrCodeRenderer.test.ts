import QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref, shallowRef } from 'vue';
import { useQrCodeRenderer } from './useQrCodeRenderer';

const request = { foreground: '#000000', background: '#ffffff', errorCorrectionLevel: 'M' as const };

function deferredQrCodes() {
  const pending: { resolve: (dataUrl: string) => void; reject: (error: Error) => void }[] = [];

  vi.spyOn(QRCode, 'toDataURL').mockImplementation((() =>
    new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    })) as never);

  return pending;
}

describe('useQrCodeRenderer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the newest code when an older render finishes last', async () => {
    const pending = deferredQrCodes();
    const { qrcode, render } = useQrCodeRenderer();

    const older = render({ ...request, text: 'older' });
    const newer = render({ ...request, text: 'newer' });
    pending[1].resolve('data:newer');
    await newer;
    pending[0].resolve('data:older');
    await older;

    expect(qrcode.value).toBe('data:newer');
  });

  it('ignores a failure from a render that has been replaced', async () => {
    const pending = deferredQrCodes();
    const { qrcode, renderError, render } = useQrCodeRenderer();

    const older = render({ ...request, text: 'older' });
    const newer = render({ ...request, text: 'newer' });
    pending[1].resolve('data:newer');
    await newer;
    pending[0].reject(new Error('too big'));
    await older;

    expect(qrcode.value).toBe('data:newer');
    expect(renderError.value).toBeUndefined();
  });

  it('does not blame a logo that was added after a plain render started', async () => {
    const pending = deferredQrCodes();
    const { renderError, render } = useQrCodeRenderer();
    const image = shallowRef<HTMLImageElement | null>(null);

    const rendering = render({ ...request, text: 'plain', logo: { image, sizePercent: ref(22) } });
    image.value = new Image();
    pending[0].reject(new Error('too big'));
    await rendering;

    expect(renderError.value).toBeDefined();
    expect(renderError.value).not.toContain('logo');
  });
});
