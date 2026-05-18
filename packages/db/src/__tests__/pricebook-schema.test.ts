/**
 * Tests for the post-CHR Drizzle pricebook schema.
 *
 * pricebookOverrides was dropped by migration 0016 (CHR-01) and replaced
 * by `pricebook_suggestions` (a corporate-review queue). The legacy
 * three-policy + franchisor-scoped pricebook checks no longer apply;
 * the new template / item schema is corporate-owned with no per-branch
 * override path under v1.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serviceCatalogTemplates,
  serviceItems,
  pricebookSuggestions,
  catalogStatus,
} from '../schema.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHR_UP = readFileSync(
  resolve(PKG_ROOT, 'migrations', '0016_corporate_hub_redesign.sql'),
  'utf8',
);

describe('PB / Drizzle schema after CHR-01', () => {
  it('exports the catalog tables + the catalog_status enum', () => {
    expect(serviceCatalogTemplates).toBeDefined();
    expect(serviceItems).toBeDefined();
    expect(catalogStatus.enumValues).toEqual(['draft', 'published', 'archived']);
  });

  it('service_items keeps the expected price columns', () => {
    const keys = Object.keys(serviceItems);
    for (const col of [
      'id',
      'templateId',
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

  it('service_items no longer carries franchisorId (CHR-01 dropped it)', () => {
    expect(Object.keys(serviceItems)).not.toContain('franchisorId');
  });

  it('exports pricebookSuggestions (CHR-01 replacement for overrides)', () => {
    expect(pricebookSuggestions).toBeDefined();
    const keys = Object.keys(pricebookSuggestions);
    for (const col of [
      'branchId',
      'serviceItemId',
      'suggestedPriceCents',
      'status',
      'suggestedByUserId',
    ]) {
      expect(keys).toContain(col);
    }
  });
});

describe('PB / migration 0016 drops the legacy override table', () => {
  it('drops pricebook_overrides', () => {
    expect(CHR_UP).toMatch(/DROP TABLE IF EXISTS pricebook_overrides/);
  });

  it('creates pricebook_suggestions in its place', () => {
    expect(CHR_UP).toMatch(/CREATE TABLE pricebook_suggestions\b/);
  });
});
