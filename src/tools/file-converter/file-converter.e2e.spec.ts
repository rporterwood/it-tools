import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';

test.describe('Tool - File converter', () => {
  test('Has correct title', async ({ page }) => {
    await page.route('**/api/v1/healthcheck', route =>
      route.fulfill({ json: { status: 'ok' } }));
    await page.route('**/api/v1/session', route => route.fulfill({ json: { userId: 0 } }));
    await page.route('**/api/v1/converters', route => route.fulfill({ json: {} }));

    await page.goto('/file-converter');
    await expect(page).toHaveTitle('File converter - IT Tools');
  });

  test('Shows the unavailable state when no backend answers', async ({ page }) => {
    await page.route('**/api/v1/healthcheck', route => route.abort());

    await page.goto('/file-converter');

    await expect(page.getByTestId('converter-unavailable')).toBeVisible();
  });

  test('Treats a 200 that is not the health payload as unavailable', async ({ page }) => {
    // Reproduces the un-proxied case: nginx serves the SPA shell with status 200.
    await page.route('**/api/v1/healthcheck', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' }));

    await page.goto('/file-converter');

    await expect(page.getByTestId('converter-unavailable')).toBeVisible();
  });

  test('Reports a failed conversion using the file status', async ({ page }) => {
    await page.route('**/api/v1/healthcheck', route => route.fulfill({ json: { status: 'ok' } }));
    await page.route('**/api/v1/session', route => route.fulfill({ json: { userId: 0 } }));
    await page.route('**/api/v1/converters', route => route.fulfill({ json: { ffmpeg: ['jpg'] } }));
    await page.route('**/api/v1/targets', route => route.fulfill({ json: { ffmpeg: ['jpg'] } }));
    // Registered before the more specific '**/api/v1/jobs/1' pattern below - Playwright
    // matches the most recently registered route first.
    await page.route('**/api/v1/jobs', route => route.fulfill({ json: { jobId: 1 } }));
    await page.route('**/api/v1/jobs/1/files', route =>
      route.fulfill({ json: { files: [{ name: 'input.png' }] } }));
    await page.route('**/api/v1/jobs/1/convert', route => route.fulfill({ json: { accepted: true } }));
    // Job status reads 'completed' while the file itself failed - the component must trust
    // the per-file status, not the job-level status.
    await page.route('**/api/v1/jobs/1', route => route.fulfill({
      json: {
        status: 'completed',
        numFiles: 1,
        files: [{ fileName: 'input.png', outputFileName: 'input.jpg', status: 'Failed, check logs' }],
      },
    }));

    await page.goto('/file-converter');

    await page.setInputFiles('input[type="file"]', {
      name: 'input.png',
      mimeType: 'image/png',
      buffer: Buffer.from('fake'),
    });

    // c-select is a custom it-tools component: data-test-id lands on the outer wrapper, not
    // on anything clickable. The trigger is `.c-select-input`; options render inside
    // `.c-select-dropdown`.
    await page.getByTestId('converter-targets').locator('.c-select-input').click();
    await page.getByTestId('converter-targets').locator('.c-select-dropdown').getByText('jpg (ffmpeg)').click();
    // exact: true - a substring match on 'Convert' also matches the unrelated 'Show what each
    // converter handles' button ('converter' contains 'convert').
    await page.getByRole('button', { name: 'Convert', exact: true }).click();

    // 'Failed, check logs' alone is not sufficient: file.status is rendered verbatim in BOTH
    // branches of the v-if="result.failed" split (see file-converter.vue), so this same literal
    // string would also appear next to a live Download button if `failed` were ever miscomputed
    // (e.g. derived from job.status instead of the per-file status). Pin the actual semantic by
    // also asserting on the alert text that only the failed branch renders, and that no Download
    // button exists for this result.
    const result = page.getByTestId('converter-result');
    await expect(result).toContainText('Failed, check logs');
    await expect(result).toContainText('Details are in the ConvertX container log.');
    await expect(result.getByRole('button', { name: /Download/ })).toHaveCount(0);
  });
});
