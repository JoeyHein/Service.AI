/**
 * TASK-PB-05 structural tests for the HQ catalog + franchisee
 * pricebook UI. End-to-end behaviour is covered by live-catalog and
 * live-pricebook against the same endpoints.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', '..');
const read = (r: string) => readFileSync(join(WEB, r), 'utf8');
const exists = (r: string) => existsSync(join(WEB, r));

describe('PB-05 / catalog UI files exist', () => {
  it.each([
    'src/app/(app)/franchisor/catalog/page.tsx',
    'src/app/(app)/franchisor/catalog/NewTemplateForm.tsx',
    'src/app/(app)/franchisor/catalog/[templateId]/page.tsx',
    'src/app/(app)/franchisor/catalog/[templateId]/TemplateEditor.tsx',
    'src/app/(app)/pricebook/page.tsx',
    'src/app/(app)/pricebook/PricebookTable.tsx',
  ])('%s exists', (p) => expect(exists(p)).toBe(true));
});

describe('PB-05 / catalog list page gates access + calls the API', () => {
  const src = read('src/app/(app)/franchisor/catalog/page.tsx');
  it('restricts to platform + franchisor scopes via notFound()', () => {
    expect(src).toMatch(/notFound\(\)/);
    expect(src).toMatch(/scope\?\.type !== 'platform'/);
    expect(src).toMatch(/scope\?\.type !== 'franchisor'/);
  });
  it('renders a status chip and links each template to its detail page', () => {
    expect(src).toMatch(/\/franchisor\/catalog\//);
    expect(src).toMatch(/t\.status/);
  });
  it('embeds the NewTemplateForm', () => {
    expect(src).toMatch(/NewTemplateForm/);
  });
});

describe('PB-05 / template editor POSTs / publishes / archives', () => {
  const src = read('src/app/(app)/franchisor/catalog/[templateId]/TemplateEditor.tsx');
  it('adds items to /items endpoint', () => {
    expect(src).toMatch(/\/api\/v1\/catalog\/templates\/.*\/items/);
  });
  it('publish + archive buttons POST to the right routes', () => {
    expect(src).toMatch(/\/publish/);
    expect(src).toMatch(/\/archive/);
    expect(src).toMatch(/data-testid="publish-btn"/);
    expect(src).toMatch(/data-testid="archive-btn"/);
  });
  it('renders an editable row only when status is draft', () => {
    expect(src).toMatch(/status === 'draft'/);
  });
});

describe('PB-05 / pricebook page', () => {
  const page = read('src/app/(app)/pricebook/page.tsx');
  const table = read('src/app/(app)/pricebook/PricebookTable.tsx');
  it('calls GET /api/v1/pricebook', () => {
    expect(page).toMatch(/\/api\/v1\/pricebook/);
  });
  it('table groups rows by category', () => {
    expect(table).toMatch(/grouped/);
    expect(table).toMatch(/category/);
  });
  it('override row POSTs to /api/v1/pricebook/overrides + DELETEs on revert', () => {
    expect(table).toMatch(/\/api\/v1\/pricebook\/overrides/);
    expect(table).toMatch(/method:\s*'POST'/);
    expect(table).toMatch(/method:\s*'DELETE'/);
  });
  it('client-side rejects below-floor / above-ceiling before the request', () => {
    expect(table).toMatch(/Below floor/);
    expect(table).toMatch(/Above ceiling/);
  });
  it('has stable testids for pricebook-table + per-row override trigger', () => {
    expect(table).toMatch(/data-testid="pricebook-table"/);
    expect(table).toMatch(/data-testid=\{`override-\$\{row\.sku\}/);
  });
});

describe('PB-05 / AppShell nav', () => {
  const src = read('src/app/(app)/AppShell.tsx');
  it('exposes Catalog (admin-only) + Pricebook (everyone) links', () => {
    expect(src).toMatch(/\/franchisor\/catalog/);
    expect(src).toMatch(/\/pricebook/);
  });
});
