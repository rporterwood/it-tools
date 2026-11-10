import { type MaybeRef, get } from '@vueuse/core';
import type { QRCodeErrorCorrectionLevel, QRCodeToDataURLOptions } from 'qrcode';
import { isRef, watch } from 'vue';
import { type QrLogoOptions, useQrCodeRenderer } from './useQrCodeRenderer';

export function useQRCode({
  text,
  color: { background, foreground },
  errorCorrectionLevel,
  options,
  logo,
}: {
  text: MaybeRef<string>
  color: { foreground: MaybeRef<string>; background: MaybeRef<string> }
  errorCorrectionLevel?: MaybeRef<QRCodeErrorCorrectionLevel>
  options?: QRCodeToDataURLOptions
  logo?: QrLogoOptions
}) {
  const { qrcode, decodes, renderError, render, clearRenderError } = useQrCodeRenderer();

  watch(
    [text, background, foreground, errorCorrectionLevel, logo?.image, logo?.sizePercent].filter(isRef),
    async () => {
      if (get(text)) {
        await render({
          text: get(text).trim(),
          foreground: get(foreground),
          background: get(background),
          errorCorrectionLevel: get(errorCorrectionLevel) ?? 'M',
          options,
          logo,
        });
      }
      else {
        clearRenderError();
      }
    },
    { immediate: true },
  );

  return { qrcode, decodes, renderError };
}
