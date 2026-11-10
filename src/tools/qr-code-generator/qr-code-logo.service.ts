import jsQR from 'jsqr';
import _ from 'lodash';
import QRCode from 'qrcode';

export const LOGO_SIZE_PERCENT = { min: 10, max: 30, default: 22 };

const ACCEPTED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

// Version 4 is the smallest code where the largest logo stays clear of the timing and alignment patterns
const MIN_VERSION_WITH_LOGO = 4;
const CLEARING_PADDING_MODULES = 1;
const QUIET_ZONE_MODULES = 4;
const SCAN_CHECK_PIXELS_PER_MODULE = 4;

export const LOGO_FILE_ACCEPT = ACCEPTED_LOGO_TYPES.join(',');

export interface QrWithLogoPlan {
  moduleCount: number
  darkModules: { column: number; row: number }[]
  logo: { x: number; y: number; width: number; height: number }
}

interface QrColors {
  foreground: string
  background: string
}

function createHighCorrectionCode(text: string) {
  const code = QRCode.create(text, { errorCorrectionLevel: 'H' });

  return code.version >= MIN_VERSION_WITH_LOGO
    ? code
    : QRCode.create(text, { errorCorrectionLevel: 'H', version: MIN_VERSION_WITH_LOGO });
}

export function planQrWithLogo({ text, logoSizePercent, logoAspectRatio }: {
  text: string
  logoSizePercent: number
  logoAspectRatio: number
}): QrWithLogoPlan {
  const { modules } = createHighCorrectionCode(text);
  const moduleCount = modules.size;
  const longestSide = (moduleCount * _.clamp(logoSizePercent, LOGO_SIZE_PERCENT.min, LOGO_SIZE_PERCENT.max)) / 100;
  const width = logoAspectRatio >= 1 ? longestSide : longestSide * logoAspectRatio;
  const height = logoAspectRatio >= 1 ? longestSide / logoAspectRatio : longestSide;

  const middle = Math.floor(moduleCount / 2);
  const halfColumns = Math.ceil(width / 2 + CLEARING_PADDING_MODULES);
  const halfRows = Math.ceil(height / 2 + CLEARING_PADDING_MODULES);
  const isCleared = (column: number, row: number) =>
    Math.abs(column - middle) < halfColumns && Math.abs(row - middle) < halfRows;

  const positions = _.range(moduleCount);
  const darkModules = positions.flatMap(row =>
    positions
      .filter(column => modules.get(row, column) === 1 && !isCleared(column, row))
      .map(column => ({ column, row })),
  );

  return {
    moduleCount,
    darkModules,
    logo: {
      x: (moduleCount - width) / 2,
      y: (moduleCount - height) / 2,
      width,
      height,
    },
  };
}

export function decodesTo({ pixels, width, height, expectedText }: {
  pixels: Uint8ClampedArray
  width: number
  height: number
  expectedText: string
}): boolean {
  return jsQR(pixels, width, height)?.data === expectedText;
}

export function getLogoFileError(file: File): string | undefined {
  if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
    return 'Please choose a PNG, JPEG, WebP or SVG image.';
  }

  if (file.size > MAX_LOGO_BYTES) {
    return 'Please choose an image of 5 MB or less.';
  }

  return undefined;
}

export function loadLogoImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const image = new Image();
    const fail = () => reject(new Error('This image could not be read.'));

    image.onload = () => (image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve(image) : fail());
    image.onerror = fail;
    reader.onload = () => {
      image.src = String(reader.result);
    };
    reader.onerror = fail;
    reader.readAsDataURL(file);
  });
}

function drawCode({ plan, pixelsPerModule, colors, logo }: {
  plan: QrWithLogoPlan
  pixelsPerModule: number
  colors: QrColors
  logo: HTMLImageElement
}): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = (plan.moduleCount + QUIET_ZONE_MODULES * 2) * pixelsPerModule;
  canvas.height = canvas.width;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('This browser could not draw the QR code.');
  }

  const toPixels = (modules: number) => (modules + QUIET_ZONE_MODULES) * pixelsPerModule;

  context.fillStyle = colors.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = colors.foreground;
  plan.darkModules.forEach(({ column, row }) => {
    context.fillRect(toPixels(column), toPixels(row), pixelsPerModule, pixelsPerModule);
  });
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    logo,
    toPixels(plan.logo.x),
    toPixels(plan.logo.y),
    plan.logo.width * pixelsPerModule,
    plan.logo.height * pixelsPerModule,
  );

  return canvas;
}

function checkCodeDecodes({ plan, colors, logo, text }: {
  plan: QrWithLogoPlan
  colors: QrColors
  logo: HTMLImageElement
  text: string
}): boolean {
  const drawn = drawCode({ plan, pixelsPerModule: SCAN_CHECK_PIXELS_PER_MODULE, colors, logo });
  const paper = document.createElement('canvas');
  paper.width = drawn.width;
  paper.height = drawn.height;

  const context = paper.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return false;
  }

  // A transparent background is read as it will print: on white paper
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, paper.width, paper.height);
  context.drawImage(drawn, 0, 0);

  const { data } = context.getImageData(0, 0, paper.width, paper.height);

  return decodesTo({ pixels: data, width: paper.width, height: paper.height, expectedText: text });
}

export function renderQrWithLogo({ text, colors, width, logo, logoSizePercent }: {
  text: string
  colors: QrColors
  width: number
  logo: HTMLImageElement
  logoSizePercent: number
}): { dataUrl: string; decodes: boolean } {
  const plan = planQrWithLogo({
    text,
    logoSizePercent,
    logoAspectRatio: logo.naturalWidth / logo.naturalHeight,
  });
  // Whole pixels per module keep every square crisp when printed
  const pixelsPerModule = Math.max(1, Math.floor(width / (plan.moduleCount + QUIET_ZONE_MODULES * 2)));

  return {
    dataUrl: drawCode({ plan, pixelsPerModule, colors, logo }).toDataURL('image/png'),
    decodes: checkCodeDecodes({ plan, colors, logo, text }),
  };
}
