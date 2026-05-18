/**
 * Structural tests for the branch pricebook UI (post-CHR-09).
 *
 * The franchise-era override flow is gone. Managers now propose price
 * changes via a Suggest button that POSTs /api/v1/pricebook/suggestions;
 * corporate reviews them at /corporate/pricebook-suggestions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', '..');
const read = (r: string) => readFileSync(join(WEB, r), 'utf8');
const exists = (r: string) => existsSync(join(WEB, r));

describe('PB / pricebook UI files exist', () => {
  it.each([
    'src/app/(app)/pricebook/page.tsx',
    'src/app/(app)/pricebook/PricebookTable.tsx',
    'src/app/(app)/corporate/pricebook-suggestions/page.tsx',
    'src/app/(app)/corporate/pricebook-suggestions/SuggestionsTable.tsx',
  ])('%s exists', (p) => expect(exists(p)).toBe(true));
});

describe('PB / branch pricebook page', () => {
  const page = read('src/app/(app)/pricebook/page.tsx');
  const table = read('src/app/(app)/pricebook/PricebookTable.tsx');

  it('calls GET /api/v1/pricebook', () => {
    expect(page).toMatch(/\/api\/v1\/pricebook/);
  });
  it('table groups rows by category', () => {
    expect(table).toMatch(/grouped/);
    expect(table).toMatch(/category/);
  });
  it('Suggest button POSTs to /api/v1/pricebook/suggestions', () => {
    expect(table).toMatch(/\/api\/v1\/pricebook\/suggestions/);
    expect(table).toMatch(/method:\s*'POST'/);
  });
  it('no longer posts to the removed overrides endpoint', () => {
    expect(table).not.toMatch(/\/api\/v1\/pricebook\/overrides/);
  });
  it('exposes the Suggest control only when canSuggest is true', () => {
    expect(table).toMatch(/canSuggest/);
    expect(table).toMatch(/>\s*Suggest\s*</);
  });
  it('has a stable testid for the table root', () => {
    expect(table).toMatch(/data-testid="pricebook-table"/);
  });
  it('page resolves canSuggest from the session role', () => {
    expect(page).toMatch(/canSuggest/);
    expect(page).toMatch(/role === 'manager'/);
  });
});

describe('PB / corporate pricebook-suggestions review queue', () => {
  const page = read('src/app/(app)/corporate/pricebook-suggestions/page.tsx');
  const table = read(
    'src/app/(app)/corporate/pricebook-suggestions/SuggestionsTable.tsx',
  );

  it('page fetches /api/v1/corporate/pricebook/suggestions', () => {
    expect(page).toMatch(/\/api\/v1\/corporate\/pricebook\/suggestions/);
  });
  it('renders both Pending and Resolved sections', () => {
    expect(page).toMatch(/Pending/);
    expect(page).toMatch(/Resolved/);
  });
  it('approve/reject post to the corporate verb endpoints', () => {
    expect(table).toMatch(
      /\/api\/v1\/corporate\/pricebook\/suggestions\/.+\/\$\{verb\}/,
    );
  });
});

describe('PB / AppShell nav', () => {
  const src = read('src/app/(app)/AppShell.tsx');
  it('exposes a Pricebook link', () => {
    expect(src).toMatch(/\/pricebook/);
  });
  it('exposes the corporate Price requests link', () => {
    expect(src).toMatch(/\/corporate\/pricebook-suggestions/);
  });
});
