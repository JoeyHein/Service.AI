/**
 * OI structural tests — office invoice console (phase 19).
 *
 * File-existence + grep-style assertions; the list endpoint behaviour is
 * covered by live-invoices.test.ts (OI-01).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', '..');
const read = (r: string) => readFileSync(join(WEB, r), 'utf8');
const exists = (r: string) => existsSync(join(WEB, r));

describe('OI / file existence', () => {
  it.each([
    'src/app/(app)/invoices/page.tsx',
    'src/app/(app)/invoices/[id]/page.tsx',
    'src/app/(app)/invoices/[id]/InvoiceActions.tsx',
  ])('%s exists', (p) => expect(exists(p)).toBe(true));
});

describe('OI-02 / list page', () => {
  const src = read('src/app/(app)/invoices/page.tsx');
  it('fetches the invoice list endpoint + filters by status', () => {
    expect(src).toMatch(/\/api\/v1\/invoices\?/);
    expect(src).toMatch(/data-testid="invoices-list"/);
    expect(src).toMatch(/status/);
  });
  it('tags balance (quote-linked) invoices', () => {
    expect(src).toMatch(/balance/);
    expect(src).toMatch(/quoteId/);
  });
});

describe('OI-03 / detail + actions', () => {
  const page = read('src/app/(app)/invoices/[id]/page.tsx');
  const actions = read('src/app/(app)/invoices/[id]/InvoiceActions.tsx');
  it('detail renders line items + total + actions', () => {
    expect(page).toMatch(/\/api\/v1\/invoices\//);
    expect(page).toMatch(/data-testid="invoice-lines"/);
    expect(page).toMatch(/InvoiceActions/);
  });
  it('actions call finalize + send + expose the pay link', () => {
    expect(actions).toMatch(/finalize/);
    expect(actions).toMatch(/send/);
    expect(actions).toMatch(/data-testid="invoice-finalize"/);
    expect(actions).toMatch(/data-testid="invoice-send"/);
    expect(actions).toMatch(/\/invoices\/.+\/pay/);
  });
});

describe('OI-02 / nav + OI-04 / job link', () => {
  it('AppShell has an Invoices nav link', () => {
    const src = read('src/app/(app)/AppShell.tsx');
    expect(src).toMatch(/data-testid="nav-invoices"/);
    expect(src).toMatch(/href="\/invoices"/);
  });
  it('job page lists the job invoices', () => {
    const src = read('src/app/(app)/jobs/[id]/page.tsx');
    expect(src).toMatch(/data-testid="job-invoices"/);
    expect(src).toMatch(/\/api\/v1\/invoices\?jobId=/);
  });
  it('QF-06 banner links to the office invoice detail', () => {
    const src = read('src/app/(app)/jobs/[id]/JobTransitionPanel.tsx');
    expect(src).toMatch(/data-testid="balance-invoice-link"/);
    expect(src).toMatch(/\/invoices\/\$\{balanceInvoiceId\}/);
  });
});
