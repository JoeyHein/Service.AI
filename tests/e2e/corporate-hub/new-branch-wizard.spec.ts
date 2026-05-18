// TODO(infra): install @playwright/test in tests/e2e and wire a Playwright
// project root before running this spec. As of CHR-06 the monorepo does not
// yet have a Playwright install; this file exists so the wizard contract
// is documented and the spec is ready to run as soon as the dep lands.
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — @playwright/test is not installed yet (see TODO above).
import { test, expect } from '@playwright/test';

const CORPORATE_EMAIL = process.env['CORPORATE_EMAIL'] ?? 'joey@opendc.ca';
const CORPORATE_PASSWORD =
  process.env['CORPORATE_PASSWORD'] ?? 'devseedpassword';

/**
 * Walks the 3-step new-branch wizard end-to-end:
 *
 *   1. Sign in as a corporate admin
 *   2. Navigate to /corporate/branches/new
 *   3. Step 1 — fill identity, click "Create branch"
 *   4. Step 2 — type a phone number, click "Save & continue"
 *   5. Step 3 — search managers, pick one, click "Finish"
 *   6. Assert we land on /corporate/branches/:id
 */
test('CHR-06 new-branch wizard happy path', async ({ page }: any) => {
  // Sign in
  await page.goto('/signin');
  await page.getByLabel('Email').fill(CORPORATE_EMAIL);
  await page.getByLabel('Password').fill(CORPORATE_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/(dashboard|corporate)/);

  // Step 1 — identity
  await page.goto('/corporate/branches/new');
  const slug = `chr06-${Date.now()}`;
  await page.getByTestId('new-branch-name').fill('CHR-06 Demo Branch');
  await page.getByTestId('new-branch-slug').fill(slug);
  await page.getByTestId('new-branch-submit-identity').click();

  // Step 2 — phone
  await page.getByTestId('new-branch-phone').fill('+15551234567');
  await page.getByTestId('new-branch-submit-phone').click();

  // Step 3 — manager (pick the first option that loads)
  await page.getByTestId('new-branch-manager-search').fill('');
  await page.waitForSelector('[data-testid^="manager-option-"]');
  await page.locator('[data-testid^="manager-option-"]').first().click();
  await page.getByTestId('new-branch-submit-manager').click();

  await page.waitForURL(/\/corporate\/branches\/[0-9a-f-]+/);
  await expect(
    page.getByTestId('branch-status-badge'),
  ).toContainText(/active|paused/);
});
