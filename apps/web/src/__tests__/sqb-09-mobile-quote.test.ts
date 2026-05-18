/**
 * Structural tests for the tech PWA quote view (SQB-09).
 *
 * Asserts the page exists, the mobile builder lives at the right
 * path, and the key offline + role behavior is encoded in the source
 * (we read the source as text rather than rendering — same pattern
 * as pricebook-ui-structure.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', '..');
const read = (r: string): string => readFileSync(join(WEB, r), 'utf8');
const exists = (r: string): boolean => existsSync(join(WEB, r));

const PAGE = 'src/app/tech/jobs/[id]/quote/new/page.tsx';
const BUILDER = 'src/app/tech/jobs/[id]/quote/new/MobileQuoteBuilder.tsx';

describe('SQB-09 / tech quote files', () => {
  it.each([PAGE, BUILDER])('%s exists', (p) => {
    expect(exists(p)).toBe(true);
  });
});

describe('SQB-09 / page wiring', () => {
  const src = read(PAGE);

  it('fetches the job by id from the URL params', () => {
    expect(src).toMatch(/\/api\/v1\/jobs\/\$\{jobId\}/);
  });

  it('returns notFound() when the job is missing', () => {
    expect(src).toMatch(/notFound\(\)/);
  });

  it('mounts MobileQuoteBuilder', () => {
    expect(src).toMatch(/MobileQuoteBuilder/);
  });
});

describe('SQB-09 / mobile builder', () => {
  const src = read(BUILDER);

  it('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"];/m);
  });

  it('talks to the quotes API surface', () => {
    expect(src).toMatch(/\/api\/v1\/quotes/);
    expect(src).toMatch(/\/api\/v1\/quotes\/\$\{quoteId\}\/price/);
    expect(src).toMatch(/\/api\/v1\/quotes\/\$\{quoteId\}\/commit/);
  });

  it('debounces re-pricing with AbortController', () => {
    expect(src).toMatch(/setTimeout/);
    expect(src).toMatch(/AbortController/);
  });

  it('reads/writes a localStorage cache of last priced response', () => {
    expect(src).toMatch(/localStorage\.getItem/);
    expect(src).toMatch(/localStorage\.setItem/);
    expect(src).toMatch(/sai\.tech\.quote\./);
  });

  it('listens for online + offline events', () => {
    expect(src).toMatch(/addEventListener\(['"]online['"]/);
    expect(src).toMatch(/addEventListener\(['"]offline['"]/);
  });

  it('disables the commit button when offline', () => {
    expect(src).toMatch(/!online/);
    expect(src).toMatch(/Offline · cannot send/);
  });

  it('renders a stale badge when serving cached prices', () => {
    expect(src).toMatch(/data-testid="stale-badge"/);
    expect(src).toMatch(/setStale/);
  });

  it('offers a bottom-sheet SKU picker, not inline autocomplete', () => {
    expect(src).toMatch(/data-testid="sku-sheet"/);
    expect(src).toMatch(/SkuPicker/);
  });

  it('uses 44px+ touch targets for primary controls', () => {
    expect(src).toMatch(/min-h-\[44px\]/);
  });

  it('queues a pending commit when offline at commit time', () => {
    expect(src).toMatch(/PENDING_COMMIT_KEY/);
    expect(src).toMatch(/queuedAt/);
  });

  it('shows the BC SQ-XXXXXX ref on success', () => {
    expect(src).toMatch(/data-testid="quote-committed"/);
    expect(src).toMatch(/supplierQuoteRef/);
  });
});
