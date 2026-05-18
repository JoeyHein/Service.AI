/**
 * SQB-08 structural tests.
 *
 * File-existence + grep-style assertions for the live quote builder
 * (`/quotes/new`) and the corporate margin policy editor
 * (`/corporate/settings/margins`). End-to-end behaviour is covered by
 * `live-quote-routes.test.ts` (commit / void / pricing pipeline) and
 * `live-margin-routes.test.ts` (margin policy CRUD).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', '..');
const read = (r: string) => readFileSync(join(WEB, r), 'utf8');
const exists = (r: string) => existsSync(join(WEB, r));

describe('SQB-08 / file existence', () => {
  it.each([
    'src/app/(app)/quotes/new/page.tsx',
    'src/app/(app)/quotes/new/QuoteBuilder.tsx',
    'src/app/(app)/corporate/settings/margins/page.tsx',
    'src/app/(app)/corporate/settings/margins/MarginSettings.tsx',
  ])('%s exists', (p) => expect(exists(p)).toBe(true));
});

describe('SQB-08 / QuoteBuilder structure', () => {
  const src = read('src/app/(app)/quotes/new/QuoteBuilder.tsx');

  it('uses apiClientFetch for all writes', () => {
    expect(src).toMatch(/apiClientFetch/);
  });
  it('wires AbortController for in-flight cancellation', () => {
    expect(src).toMatch(/AbortController/);
  });
  it('calls the /api/v1/quotes surface', () => {
    expect(src).toMatch(/\/api\/v1\/quotes/);
    expect(src).toMatch(/\/api\/v1\/quotes\/.+?\/price/);
    expect(src).toMatch(/\/api\/v1\/quotes\/.+?\/commit/);
  });
  it('shows the margin override popover with a required reason and role gate', () => {
    expect(src).toMatch(/margin-override-popover/);
    expect(src).toMatch(/reason/i);
    expect(src).toMatch(/canOverrideMargin/);
    expect(src).toMatch(/corporate_admin/);
  });
  it('hides the margin column from non-managers', () => {
    expect(src).toMatch(/canSeeMargin/);
  });
  it('has stable testids for the live builder surfaces', () => {
    expect(src).toMatch(/data-testid="quote-builder"/);
    expect(src).toMatch(/data-testid="line-table"/);
    expect(src).toMatch(/data-testid="totals-card"/);
    expect(src).toMatch(/data-testid="commit-bar"/);
    expect(src).toMatch(/data-testid="send-to-supplier"/);
  });
  it('debounces re-pricing', () => {
    expect(src).toMatch(/setTimeout/);
    expect(src).toMatch(/300/);
  });
  it('handles MARGIN_OUT_OF_BOUNDS as a toast', () => {
    expect(src).toMatch(/MARGIN_OUT_OF_BOUNDS/);
  });
  it('renders a manager-only commission preview', () => {
    expect(src).toMatch(/commission-preview/);
    expect(src).toMatch(/isManager/);
  });
});

describe('SQB-08 / MarginSettings structure', () => {
  const page = read('src/app/(app)/corporate/settings/margins/page.tsx');
  const settings = read(
    'src/app/(app)/corporate/settings/margins/MarginSettings.tsx',
  );

  it('page fetches /api/v1/corporate/margins', () => {
    expect(page).toMatch(/\/api\/v1\/corporate\/margins/);
  });
  it('component writes the policy + overrides via the corporate surface', () => {
    expect(settings).toMatch(/\/api\/v1\/corporate\/margins\/policy/);
    expect(settings).toMatch(/\/api\/v1\/corporate\/margin-overrides/);
    expect(settings).toMatch(/marginPct/);
  });
  it('uses apiClientFetch for every write', () => {
    expect(settings).toMatch(/apiClientFetch/);
  });
  it('exposes the collapsed bounds panel', () => {
    expect(settings).toMatch(/bounds-toggle/);
    expect(settings).toMatch(/bounds-panel/);
  });
});

describe('SQB-08 / AppShell nav links', () => {
  const src = read('src/app/(app)/AppShell.tsx');

  it('exposes a New quote link for branch users', () => {
    expect(src).toMatch(/\/quotes\/new/);
    expect(src).toMatch(/isBranchScope/);
  });
  it('exposes a Margins link for corporate users', () => {
    expect(src).toMatch(/\/corporate\/settings\/margins/);
    expect(src).toMatch(/isCorporate/);
  });
});
