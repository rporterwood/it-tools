import QRCode, { type QRCodeErrorCorrectionLevel, type QRCodeToDataURLOptions } from 'qrcode';
import { type Ref, ref } from 'vue';
import { renderQrWithLogo } from './qr-code-logo.service';

const DEFAULT_LOGO_CODE_WIDTH = 2048;

export interface QrLogoOptions {
  image: Ref<HTMLImageElement | null>
  sizePercent: Ref<number>
}

export interface QrRenderRequest {
  text: string
  foreground: string
  background: string
  errorCorrectionLevel: QRCodeErrorCorrectionLevel
  options?: QRCodeToDataURLOptions
  logo?: QrLogoOptions
}

async function renderCode({ text, foreground, background, errorCorrectionLevel, options, logo }: QrRenderRequest) {
  const logoImage = logo?.image.value;

  if (logo && logoImage) {
    return renderQrWithLogo({
      text,
      colors: { foreground, background },
      width: options?.width ?? DEFAULT_LOGO_CODE_WIDTH,
      logo: logoImage,
      logoSizePercent: logo.sizePercent.value,
    });
  }

  const dataUrl = await QRCode.toDataURL(text, {
    color: { dark: foreground, light: background, ...options?.color },
    errorCorrectionLevel,
    ...options,
  });

  return { dataUrl, decodes: undefined };
}

export function useQrCodeRenderer() {
  const qrcode = ref('');
  const decodes = ref<boolean>();
  const renderError = ref<string>();

  let latestRender = 0;

  async function render(request: QrRenderRequest) {
    latestRender += 1;
    const thisRender = latestRender;
    const hasLogo = Boolean(request.logo?.image.value);

    try {
      const result = await renderCode(request);
      if (thisRender !== latestRender) {
        return;
      }
      qrcode.value = result.dataUrl;
      decodes.value = result.decodes;
      renderError.value = undefined;
    }
    catch {
      if (thisRender !== latestRender) {
        return;
      }
      qrcode.value = '';
      decodes.value = undefined;
      renderError.value = hasLogo
        ? 'This QR code could not be made with a logo. Try shorter text or a different image.'
        : 'This QR code could not be made. Try shorter text.';
    }
  }

  function clearRenderError() {
    renderError.value = undefined;
  }

  return { qrcode, decodes, renderError, render, clearRenderError };
}
