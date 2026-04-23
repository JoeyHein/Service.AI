/**
 * TASK-CJ-05 + TASK-CJ-06 structural tests.
 *
 * Filesystem + content-match assertions. End-to-end behaviour (UI
 * round-trips → API → DB) is covered by the live-customers.test.ts /
 * live-jobs.test.ts / live-job-photos.test.ts suites against the same
 * endpoints the UI calls.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', '..');
const read = (r: string) => readFileSync(join(WEB, r), 'utf8');
const exists = (r: string) => existsSync(join(WEB, r));

describe('CJ-05 / customer UI files', () => {
  it.each([
    'src/app/(app)/customers/page.tsx',
    'src/app/(app)/customers/new/page.tsx',
    'src/app/(app)/customers/new/NewCustomerForm.tsx',
    'src/app/(app)/customers/[id]/page.tsx',
    'src/app/(app)/customers/[id]/EditCustomerForm.tsx',
  ])('%s exists', (p) => expect(exists(p)).toBe(true));

  it('customer list page calls GET /api/v1/customers with pagination', () => {
    const src = read('src/app/(app)/customers/page.tsx');
    expect(src).toMatch(/\/api\/v1\/customers/);
    expect(src).toMatch(/limit/);
    expect(src).toMatch(/offset/);
  });

  it('new-customer form POSTs to /api/v1/customers and calls the Places adapter', () => {
    const src = read('src/app/(app)/customers/new/NewCustomerForm.tsx');
    expect(src).toMatch(/\/api\/v1\/customers/);
    expect(src).toMatch(/\/api\/v1\/places\/autocomplete/);
    expect(src).toMatch(/\/api\/v1\/places\//);
    expect(src).toMatch(/data-testid="place-candidates"/);
  });

  it('customer detail page loads + deletes', () => {
    const src = read('src/app/(app)/customers/[id]/page.tsx');
    expect(src).toMatch(/\/api\/v1\/customers\//);
    expect(src).toMatch(/notFound\(\)/);
    const form = read('src/app/(app)/customers/[id]/EditCustomerForm.tsx');
    expect(form).toMatch(/method:\s*'PATCH'/);
    expect(form).toMatch(/method:\s*'DELETE'/);
  });
});

describe('CJ-06 / job UI files', () => {
  it.each([
    'src/app/(app)/jobs/page.tsx',
    'src/app/(app)/jobs/new/page.tsx',
    'src/app/(app)/jobs/new/NewJobForm.tsx',
    'src/app/(app)/jobs/[id]/page.tsx',
    'src/app/(app)/jobs/[id]/JobTransitionPanel.tsx',
    'src/app/(app)/jobs/[id]/JobPhotos.tsx',
  ])('%s exists', (p) => expect(exists(p)).toBe(true));

  it('job list supports status filter + pagination', () => {
    const src = read('src/app/(app)/jobs/page.tsx');
    expect(src).toMatch(/\/api\/v1\/jobs/);
    expect(src).toMatch(/status/);
    expect(src).toMatch(/data-testid="jobs-list"/);
  });

  it('new job form POSTs to /api/v1/jobs and reads customers from the API', () => {
    const page = read('src/app/(app)/jobs/new/page.tsx');
    expect(page).toMatch(/\/api\/v1\/customers/);
    const form = read('src/app/(app)/jobs/new/NewJobForm.tsx');
    expect(form).toMatch(/\/api\/v1\/jobs/);
  });

  it('job detail page renders transition panel + photos', () => {
    const page = read('src/app/(app)/jobs/[id]/page.tsx');
    expect(page).toMatch(/\/api\/v1\/jobs\//);
    expect(page).toMatch(/JobTransitionPanel/);
    expect(page).toMatch(/JobPhotos/);
  });

  it('transition panel encodes the matrix and POSTs to /transition', () => {
    const src = read('src/app/(app)/jobs/[id]/JobTransitionPanel.tsx');
    expect(src).toMatch(/unassigned/);
    expect(src).toMatch(/en_route/);
    expect(src).toMatch(/in_progress/);
    expect(src).toMatch(/\/api\/v1\/jobs\/.*\/transition/);
    expect(src).toMatch(/data-testid="transition-buttons"/);
  });

  it('photo gallery gets presigned URLs then finalises', () => {
    const src = read('src/app/(app)/jobs/[id]/JobPhotos.tsx');
    expect(src).toMatch(/\/photos\/upload-url/);
    expect(src).toMatch(/\/api\/v1\/jobs\/.*\/photos/);
    expect(src).toMatch(/data-testid="photo-gallery"/);
  });
});

describe('CJ-05+06 / AppShell nav', () => {
  const src = read('src/app/(app)/AppShell.tsx');
  it('shows Customers + Jobs links', () => {
    expect(src).toMatch(/\/customers/);
    expect(src).toMatch(/\/jobs/);
  });
});
