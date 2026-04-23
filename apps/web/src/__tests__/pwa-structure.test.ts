/**
 * TASK-TM-01 — PWA shell structural tests.
 *
 * Live browser-install verification is Playwright territory; here we
 * lock down the structural properties that the Lighthouse install
 * criteria also check:
 *   - a manifest with the required fields
 *   - at least one icon each at 192×192 and 512×512
 *   - a registered service worker with the required caching strategies
 *   - the root layout actually loads the registration component
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const WEB_ROOT = join(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(WEB_ROOT, rel), 'utf-8');
}
function exists(rel: string): boolean {
  return existsSync(join(WEB_ROOT, rel));
}

describe('TM-01 / manifest.webmanifest', () => {
  it('served at public/manifest.webmanifest', () => {
    expect(exists('public/manifest.webmanifest')).toBe(true);
  });

  it('declares name, short_name, start_url, display=standalone, theme + background colours', () => {
    const m = JSON.parse(read('public/manifest.webmanifest')) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      theme_color?: string;
      background_color?: string;
      icons?: Array<{ sizes?: string }>;
    };
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBeTruthy();
    expect(m.display).toBe('standalone');
    expect(m.theme_color).toMatch(/^#/);
    expect(m.background_color).toMatch(/^#/);
  });

  it('includes 192×192 and 512×512 icons', () => {
    const m = JSON.parse(read('public/manifest.webmanifest')) as {
      icons?: Array<{ sizes?: string; src?: string }>;
    };
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('icon files exist on disk and are non-empty PNGs', () => {
    for (const p of ['public/icons/icon-192.png', 'public/icons/icon-512.png']) {
      expect(exists(p)).toBe(true);
      expect(statSync(join(WEB_ROOT, p)).size).toBeGreaterThan(100);
    }
  });
});

describe('TM-01 / service worker', () => {
  it('public/sw.js is present and non-empty', () => {
    expect(exists('public/sw.js')).toBe(true);
    expect(statSync(join(WEB_ROOT, 'public/sw.js')).size).toBeGreaterThan(200);
  });

  it('implements install + activate + fetch lifecycle handlers', () => {
    const sw = read('public/sw.js');
    expect(sw).toMatch(/addEventListener\(['"]install['"]/);
    expect(sw).toMatch(/addEventListener\(['"]activate['"]/);
    expect(sw).toMatch(/addEventListener\(['"]fetch['"]/);
  });

  it('handles /api/* requests with a network-first strategy', () => {
    const sw = read('public/sw.js');
    expect(sw).toMatch(/networkFirst/);
    expect(sw).toMatch(/\/api\//);
  });

  it('handles hashed static assets with a cache-first strategy', () => {
    const sw = read('public/sw.js');
    expect(sw).toMatch(/cacheFirst/);
    expect(sw).toMatch(/_next\/static/);
  });
});

describe('TM-04 / camera capture on JobPhotos input', () => {
  it('JobPhotos file input carries capture="environment" so mobile opens the rear camera', () => {
    const content = read('src/app/(app)/jobs/[id]/JobPhotos.tsx');
    expect(content).toMatch(/capture=["']environment["']/);
    expect(content).toMatch(/accept=["']image\/\*["']/);
  });

  it('JobPhotos upload reuses the phase-3 presigned-URL flow (upload-url + /photos finalise)', () => {
    const content = read('src/app/(app)/jobs/[id]/JobPhotos.tsx');
    expect(content).toMatch(/upload-url/);
    expect(content).toMatch(/\/photos['"`]/);
  });
});

describe('TM-01 / root layout registers the service worker', () => {
  it('root layout declares the manifest URL', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toMatch(/manifest\.webmanifest/);
  });

  it('root layout mounts <ServiceWorkerRegistration />', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toMatch(/ServiceWorkerRegistration/);
  });

  it('registration component calls navigator.serviceWorker.register("/sw.js")', () => {
    const reg = read('src/app/ServiceWorkerRegistration.tsx');
    expect(reg).toMatch(/navigator\.serviceWorker/);
    expect(reg).toMatch(/register\(['"]\/sw\.js['"]/);
  });

  it('root layout exports a viewport with themeColor', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toMatch(/themeColor/);
  });
});
