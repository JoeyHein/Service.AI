import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serviceCatalogTemplates,
  serviceItems,
  pricebookOverrides,
  catalogStatus,
} from '../schema.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(resolve(PKG_ROOT, 'migrations', '0006_pricebook.sql'), 'utf8');
const DOWN = readFileSync(
  resolve(PKG_ROOT, 'migrations', '0006_pricebook.down.sql'),
  'utf8',
);

describe('PB-01 / Drizzle schema', () => {
  it('exports all three tables + the enum', () => {
    expect(serviceCatalogTemplates).toBeDefined();
    expect(serviceItems).toBeDefined();
    expect(pricebookOverrides).toBeDefined();
    expect(catalogStatus.enumValues).toEqual(['draft', 'published', 'archived']);
  });

  it('service_items has the expected price columns', () => {
    const keys = Object.keys(serviceItems);
    for (const col of [
      'id',
      'templateId',
      'franchisorId',
      'sku',
      'name',
      'category',
      'unit',
      'basePrice',
      'floorPrice',
      'ceilingPrice',
      'sortOrder',
    ]) {
      expect(keys).toContain(col);
    }
  });

  it('pricebookOverrides carries denormalised franchisor_id for RLS', () => {
    expect(Object.keys(pricebookOverrides)).toContain('franchisorId');
  });
});

describe('PB-01 / migration 0006 structure', () => {
  const tables = [
    'service_catalog_templates',
    'service_items',
    'pricebook_overrides',
  ] as const;

  it('creates all three tables', () => {
    for (const t of tables) {
      expect(UP).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
    }
  });

  it('templates + items have a READ-only scoped policy for franchisee users', () => {
    expect(UP).toMatch(/CREATE POLICY service_catalog_templates_scoped_read/);
    expect(UP).toMatch(/CREATE POLICY service_items_scoped_read/);
    // FOR SELECT USING ... — matches the read-only pattern
    expect(UP).toMatch(
      /service_catalog_templates_scoped_read[\s\S]+?FOR SELECT USING/,
    );
    expect(UP).toMatch(/service_items_scoped_read[\s\S]+?FOR SELECT USING/);
  });

  it('pricebook_overrides uses the three-policy franchisee-scoped pattern', () => {
    expect(UP).toMatch(/CREATE POLICY pricebook_overrides_platform_admin/);
    expect(UP).toMatch(/CREATE POLICY pricebook_overrides_franchisor_admin/);
    expect(UP).toMatch(/CREATE POLICY pricebook_overrides_scoped/);
  });

  it('enables + forces RLS on every table', () => {
    for (const t of tables) {
      expect(UP).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(UP).toMatch(new RegExp(`ALTER TABLE ${t}\\s+FORCE  ROW LEVEL SECURITY`));
    }
  });

  it('down migration drops everything + the enum', () => {
    for (const t of tables) {
      expect(DOWN).toMatch(new RegExp(`DROP TABLE IF EXISTS ${t}\\s+CASCADE`));
    }
    expect(DOWN).toMatch(/DROP TYPE IF EXISTS catalog_status/);
  });

  it('down drops tables in FK-safe order (overrides → items → templates)', () => {
    const overridesIdx = DOWN.indexOf('DROP TABLE IF EXISTS pricebook_overrides');
    const itemsIdx = DOWN.indexOf('DROP TABLE IF EXISTS service_items');
    const templatesIdx = DOWN.indexOf('DROP TABLE IF EXISTS service_catalog_templates');
    expect(overridesIdx).toBeLessThan(itemsIdx);
    expect(itemsIdx).toBeLessThan(templatesIdx);
  });
});
