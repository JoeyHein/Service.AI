/**
 * TASK-DB-01 + TASK-DB-04 structural tests for the dispatch board +
 * static map. Round-trip behaviour is covered by the live assignment
 * + SSE tests against the same endpoints this UI calls.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', '..');
const read = (r: string) => readFileSync(join(WEB, r), 'utf8');
const exists = (r: string) => existsSync(join(WEB, r));

describe('DB-01 / dispatch board files', () => {
  it.each([
    'src/app/(app)/dispatch/page.tsx',
    'src/app/(app)/dispatch/DispatchBoard.tsx',
  ])('%s exists', (p) => expect(exists(p)).toBe(true));

  it('page gates to franchisee-scoped callers via notFound()', () => {
    const src = read('src/app/(app)/dispatch/page.tsx');
    expect(src).toMatch(/notFound\(\)/);
    expect(src).toMatch(/scope\?\.type !== 'franchisee'/);
  });

  it('page fetches techs + jobs from the API', () => {
    const src = read('src/app/(app)/dispatch/page.tsx');
    expect(src).toMatch(/\/api\/v1\/techs/);
    expect(src).toMatch(/\/api\/v1\/jobs/);
  });

  it('board uses @dnd-kit and wires assign / unassign', () => {
    const src = read('src/app/(app)/dispatch/DispatchBoard.tsx');
    expect(src).toMatch(/@dnd-kit\/core/);
    expect(src).toMatch(/DndContext/);
    expect(src).toMatch(/useDraggable/);
    expect(src).toMatch(/useDroppable/);
    expect(src).toMatch(/\/api\/v1\/jobs\/.*\/assign/);
    expect(src).toMatch(/\/api\/v1\/jobs\/.*\/unassign/);
  });

  it('board subscribes to /api/v1/jobs/events/stream via EventSource', () => {
    const src = read('src/app/(app)/dispatch/DispatchBoard.tsx');
    expect(src).toMatch(/EventSource/);
    expect(src).toMatch(/\/api\/v1\/jobs\/events\/stream/);
    expect(src).toMatch(/job\.assigned/);
    expect(src).toMatch(/job\.unassigned/);
    expect(src).toMatch(/job\.transitioned/);
  });

  it('has stable data-testids for the board + each column + each card', () => {
    const src = read('src/app/(app)/dispatch/DispatchBoard.tsx');
    expect(src).toMatch(/data-testid="dispatch-board"/);
    expect(src).toMatch(/data-testid=\{`column-\$\{id\}/);
    expect(src).toMatch(/data-testid=\{`job-card-\$\{job\.id\}/);
  });
});

describe('DB-04 / static map component', () => {
  const src = read('src/components/StaticMap.tsx');

  it('file exists', () => {
    expect(exists('src/components/StaticMap.tsx')).toBe(true);
  });

  it('degrades when coordinates are missing', () => {
    expect(src).toMatch(/data-testid="static-map-placeholder"/);
    expect(src).toMatch(/No address on file/);
  });

  it('degrades when GOOGLE_MAPS_API_KEY is absent', () => {
    expect(src).toMatch(/data-testid="static-map-no-key"/);
    expect(src).toMatch(/NEXT_PUBLIC_GOOGLE_MAPS_API_KEY/);
    expect(src).toMatch(/Open in Google Maps/);
  });

  it('renders a maps.googleapis.com/staticmap image when key + coords are present', () => {
    expect(src).toMatch(/maps\.googleapis\.com\/maps\/api\/staticmap/);
    expect(src).toMatch(/data-testid="static-map-image"/);
  });

  it('job detail page renders <StaticMap /> above photos', () => {
    const jobDetail = read('src/app/(app)/jobs/[id]/page.tsx');
    expect(jobDetail).toMatch(/import \{ StaticMap \}/);
    expect(jobDetail).toMatch(/<StaticMap/);
    // StaticMap appears before JobPhotos
    const mapIdx = jobDetail.indexOf('<StaticMap');
    const photosIdx = jobDetail.indexOf('<JobPhotos');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(photosIdx).toBeGreaterThan(-1);
    expect(mapIdx).toBeLessThan(photosIdx);
  });
});

describe('DB-01 / AppShell nav includes Dispatch', () => {
  const src = read('src/app/(app)/AppShell.tsx');
  it('renders a Dispatch link', () => {
    expect(src).toMatch(/\/dispatch/);
  });
});
