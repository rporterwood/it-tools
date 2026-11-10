import { Buffer } from 'node:buffer';
import { type Page, expect, test } from '@playwright/test';

const SQUARE_LOGO = {
  name: 'logo.svg',
  mimeType: 'image/svg+xml',
  buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="50" fill="#1f6feb"/></svg>'),
};

const qrImage = (page: Page) => page.locator('.n-image img');
const qrImageWidth = (page: Page) => qrImage(page).evaluate((image: HTMLImageElement) => image.naturalWidth);
const chooseLogo = (page: Page, file: typeof SQUARE_LOGO) => page.getByTestId('qr-logo-input').setInputFiles(file);

test.describe('Tool - QR code generator logo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/qrcode-generator');
    await expect(qrImage(page)).toHaveAttribute('src', /^data:image\/png/);
  });

  test('Without a logo the code is large enough for print and has no scan check', async ({ page }) => {
    await expect.poll(() => qrImageWidth(page)).toBeGreaterThanOrEqual(2000);
    await expect(page.getByTestId('qr-scan-status')).toHaveCount(0);
  });

  test('Adding a logo changes the code, locks high correction and reports that it decodes', async ({ page }) => {
    const before = await qrImage(page).getAttribute('src');

    await chooseLogo(page, SQUARE_LOGO);

    await expect(page.getByTestId('qr-scan-status')).toContainText('reads correctly');
    await expect.poll(() => qrImage(page).getAttribute('src')).not.toEqual(before);
    await expect.poll(() => qrImageWidth(page)).toBeGreaterThanOrEqual(1900);
    await expect(page.getByTestId('qr-logo-correction-note')).toBeVisible();
  });

  test('Removing the logo restores the plain code and the correction setting', async ({ page }) => {
    const before = await qrImage(page).getAttribute('src');

    await chooseLogo(page, SQUARE_LOGO);
    await expect(page.getByTestId('qr-scan-status')).toBeVisible();
    await page.getByTestId('qr-logo-remove').click();

    await expect(page.getByTestId('qr-scan-status')).toHaveCount(0);
    await expect(page.getByTestId('qr-logo-correction-note')).toHaveCount(0);
    await expect.poll(() => qrImage(page).getAttribute('src')).toEqual(before);
  });

  test('A file that is not an image is refused with a message', async ({ page }) => {
    await chooseLogo(page, { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });

    await expect(page.getByTestId('qr-logo-error')).toBeVisible();
    await expect(page.getByTestId('qr-scan-status')).toHaveCount(0);
  });

  test('A corrupt image is refused with a message', async ({ page }) => {
    await chooseLogo(page, { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') });

    await expect(page.getByTestId('qr-logo-error')).toBeVisible();
    await expect(page.getByTestId('qr-scan-status')).toHaveCount(0);
  });

  test('Text too long to fit with a logo shows a message and blocks the download', async ({ page }) => {
    await chooseLogo(page, SQUARE_LOGO);
    await expect(page.getByTestId('qr-scan-status')).toBeVisible();

    await page.getByPlaceholder('Your link or text...').fill('x'.repeat(1500));

    await expect(page.getByTestId('qr-render-error')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download qr-code' })).toHaveClass(/disabled/);
  });

  test('Clearing the text removes the too-long message', async ({ page }) => {
    await page.getByPlaceholder('Your link or text...').fill('x'.repeat(3000));
    await expect(page.getByTestId('qr-render-error')).toBeVisible();

    await page.getByPlaceholder('Your link or text...').fill('');

    await expect(page.getByTestId('qr-render-error')).toHaveCount(0);
  });
});

test.describe('Tool - WiFi QR code generator logo', () => {
  test('Adding a logo reports that the Wi-Fi code decodes', async ({ page }) => {
    await page.goto('/wifi-qrcode-generator');
    await page.getByPlaceholder('Your WiFi SSID...').fill('Office Guest');
    await page.getByPlaceholder('Your WiFi Password...').fill('correct-horse-battery');
    await expect(page.getByAltText('wifi-qrcode')).toHaveAttribute('src', /^data:image\/png/);

    await chooseLogo(page, SQUARE_LOGO);

    await expect(page.getByTestId('qr-scan-status')).toContainText('reads correctly');
  });
});
