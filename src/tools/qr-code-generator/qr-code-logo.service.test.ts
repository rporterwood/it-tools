import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { type QrWithLogoPlan, decodesTo, getLogoFileError, planQrWithLogo } from './qr-code-logo.service';

const URL_TEXT = 'https://example.com/spring-offer';
const PIXELS_PER_MODULE = 4;
const QUIET_ZONE = 4;

function fileOf({ type, size }: { type: string; size: number }): File {
  return new File([new Uint8Array(size)], 'logo', { type });
}

function rasterize(plan: QrWithLogoPlan) {
  const size = (plan.moduleCount + QUIET_ZONE * 2) * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);

  function paintBlack(left: number, top: number, right: number, bottom: number) {
    for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
      for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
        const offset = (y * size + x) * 4;
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
      }
    }
  }

  const toPixels = (modules: number) => (modules + QUIET_ZONE) * PIXELS_PER_MODULE;

  plan.darkModules.forEach(({ column, row }) => {
    paintBlack(toPixels(column), toPixels(row), toPixels(column + 1), toPixels(row + 1));
  });

  // A solid black logo is the harshest case: nothing behind it can help a reader
  paintBlack(
    toPixels(plan.logo.x),
    toPixels(plan.logo.y),
    toPixels(plan.logo.x + plan.logo.width),
    toPixels(plan.logo.y + plan.logo.height),
  );

  return { pixels, width: size, height: size };
}

function darkModulesInBlock(plan: QrWithLogoPlan, block: { columns: [number, number]; rows: [number, number] }) {
  return plan.darkModules.filter(({ column, row }) =>
    column >= block.columns[0] && column <= block.columns[1] && row >= block.rows[0] && row <= block.rows[1],
  );
}

describe('qr-code-logo service', () => {
  describe('planQrWithLogo', () => {
    it('removes whole modules in a square around a square logo and keeps every other module', () => {
      const plan = planQrWithLogo({ text: URL_TEXT, logoSizePercent: 22, logoAspectRatio: 1 });
      const original = QRCode.create(URL_TEXT, { errorCorrectionLevel: 'H', version: 4 });

      let expectedDark = 0;
      for (let row = 0; row < 33; row += 1) {
        for (let column = 0; column < 33; column += 1) {
          const insideClearing = column >= 12 && column <= 20 && row >= 12 && row <= 20;
          if (!insideClearing && original.modules.get(row, column) === 1) {
            expectedDark += 1;
          }
        }
      }

      expect(plan.moduleCount).toBe(33);
      expect(darkModulesInBlock(plan, { columns: [12, 20], rows: [12, 20] })).toEqual([]);
      expect(plan.darkModules).toHaveLength(expectedDark);
    });

    it('centers a square logo at the requested share of the code width', () => {
      const { logo } = planQrWithLogo({ text: URL_TEXT, logoSizePercent: 22, logoAspectRatio: 1 });

      expect(logo.width).toBeCloseTo(7.26);
      expect(logo.height).toBeCloseTo(7.26);
      expect(logo.x).toBeCloseTo(12.87);
      expect(logo.y).toBeCloseTo(12.87);
    });

    it('fits a wide logo to the size limit and clears only a wide, short band', () => {
      const plan = planQrWithLogo({ text: URL_TEXT, logoSizePercent: 22, logoAspectRatio: 2 });

      expect(plan.logo.width).toBeCloseTo(7.26);
      expect(plan.logo.height).toBeCloseTo(3.63);
      expect(plan.logo.y).toBeCloseTo(14.685);
      expect(darkModulesInBlock(plan, { columns: [12, 20], rows: [14, 18] })).toEqual([]);
      expect(darkModulesInBlock(plan, { columns: [12, 20], rows: [13, 13] })).not.toEqual([]);
    });

    it('fits a tall logo to the size limit and clears only a narrow, tall band', () => {
      const plan = planQrWithLogo({ text: URL_TEXT, logoSizePercent: 22, logoAspectRatio: 0.5 });

      expect(plan.logo.width).toBeCloseTo(3.63);
      expect(plan.logo.height).toBeCloseTo(7.26);
      expect(plan.logo.x).toBeCloseTo(14.685);
      expect(darkModulesInBlock(plan, { columns: [14, 18], rows: [12, 20] })).toEqual([]);
      expect(darkModulesInBlock(plan, { columns: [13, 13], rows: [12, 20] })).not.toEqual([]);
    });

    it('gives very short text enough modules to leave room for a logo', () => {
      expect(planQrWithLogo({ text: 'hi', logoSizePercent: 22, logoAspectRatio: 1 }).moduleCount).toBe(33);
    });

    it('lets long text grow past the minimum size', () => {
      const plan = planQrWithLogo({ text: 'x'.repeat(300), logoSizePercent: 22, logoAspectRatio: 1 });

      expect(plan.moduleCount).toBeGreaterThan(33);
    });

    it('never makes the logo larger than the maximum, whatever size is asked for', () => {
      const { logo } = planQrWithLogo({ text: URL_TEXT, logoSizePercent: 99, logoAspectRatio: 1 });

      expect(logo.width).toBeCloseTo(9.9);
    });

    it('never makes the logo smaller than the minimum, whatever size is asked for', () => {
      const { logo } = planQrWithLogo({ text: URL_TEXT, logoSizePercent: 1, logoAspectRatio: 1 });

      expect(logo.width).toBeCloseTo(3.3);
    });

    it.each([
      ['very short text', 'hi'],
      ['a typical link', URL_TEXT],
      ['a Wi-Fi network', 'WIFI:S:Office Guest;T:WPA;P:correct-horse-battery;H:false;;'],
      ['accented text and emoji', 'Café ☕ menu'],
      ['300 characters', 'x'.repeat(300)],
      ['1000 characters', 'y'.repeat(1000)],
    ])('still decodes with the largest solid logo for %s', (_label, text) => {
      const plan = planQrWithLogo({ text, logoSizePercent: 100, logoAspectRatio: 1 });

      expect(decodesTo({ ...rasterize(plan), expectedText: text })).toBe(true);
    });
  });

  describe('decodesTo', () => {
    it('is false for an image with no code in it', () => {
      const width = 132;
      const pixels = new Uint8ClampedArray(width * width * 4).fill(255);

      expect(decodesTo({ pixels, width, height: width, expectedText: URL_TEXT })).toBe(false);
    });

    it('is false when the code holds different text', () => {
      const plan = planQrWithLogo({ text: URL_TEXT, logoSizePercent: 10, logoAspectRatio: 1 });

      expect(decodesTo({ ...rasterize(plan), expectedText: 'https://example.com/other' })).toBe(false);
    });
  });

  describe('getLogoFileError', () => {
    it.each(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])('accepts %s', (type) => {
      expect(getLogoFileError(fileOf({ type, size: 1024 }))).toBeUndefined();
    });

    it('rejects a file that is not an image', () => {
      expect(getLogoFileError(fileOf({ type: 'application/pdf', size: 1024 }))).toBeDefined();
    });

    it('accepts a file of exactly 5 MB', () => {
      expect(getLogoFileError(fileOf({ type: 'image/png', size: 5 * 1024 * 1024 }))).toBeUndefined();
    });

    it('rejects a file over 5 MB', () => {
      expect(getLogoFileError(fileOf({ type: 'image/png', size: 5 * 1024 * 1024 + 1 }))).toBeDefined();
    });
  });
});
