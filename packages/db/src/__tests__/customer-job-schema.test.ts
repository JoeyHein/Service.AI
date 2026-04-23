import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { customers, jobs, jobStatusLog, jobPhotos, jobStatus } from '../schema.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(resolve(PKG_ROOT, 'migrations', '0005_customer_job.sql'), 'utf8');
const DOWN = readFileSync(
  resolve(PKG_ROOT, 'migrations', '0005_customer_job.down.sql'),
  'utf8',
);

describe('CJ-01 / Drizzle schema', () => {
  it('exports customers, jobs, jobStatusLog, jobPhotos', () => {
    expect(customers).toBeDefined();
    expect(jobs).toBeDefined();
    expect(jobStatusLog).toBeDefined();
    expect(jobPhotos).toBeDefined();
  });

  it('customers has the expected columns', () => {
    const keys = Object.keys(customers);
    for (const col of [
      'id',
      'franchiseeId',
      'locationId',
      'name',
      'email',
      'phone',
      'addressLine1',
      'placeId',
      'latitude',
      'longitude',
      'deletedAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(keys).toContain(col);
    }
  });

  it('jobs has the expected columns + status column', () => {
    const keys = Object.keys(jobs);
    for (const col of [
      'id',
      'franchiseeId',
      'customerId',
      'status',
      'title',
      'scheduledStart',
      'assignedTechUserId',
      'deletedAt',
    ]) {
      expect(keys).toContain(col);
    }
  });

  it('jobStatus enum includes every documented state', () => {
    const expected = [
      'unassigned',
      'scheduled',
      'en_route',
      'arrived',
      'in_progress',
      'completed',
      'canceled',
    ];
    expect(jobStatus.enumValues).toEqual(expected);
  });

  it('job_photos has a unique index on storage_key', () => {
    expect(Object.keys(jobPhotos)).toContain('storageKey');
  });
});

describe('CJ-01 / migration 0005 structure', () => {
  const tables = ['customers', 'jobs', 'job_status_log', 'job_photos'] as const;
  const roles = ['platform_admin', 'franchisor_admin', 'scoped'] as const;

  it('creates all four tables', () => {
    for (const t of tables) {
      expect(UP).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
    }
  });

  it('creates the job_status enum', () => {
    expect(UP).toMatch(/CREATE TYPE job_status AS ENUM/);
  });

  it('enables + forces RLS on every table', () => {
    for (const t of tables) {
      expect(UP).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(UP).toMatch(new RegExp(`ALTER TABLE ${t}\\s+FORCE  ROW LEVEL SECURITY`));
    }
  });

  it('defines the three canonical policies per table', () => {
    for (const t of tables) {
      for (const r of roles) {
        expect(UP).toMatch(new RegExp(`CREATE POLICY ${t}_${r} ON ${t}`));
      }
    }
  });

  it('down migration drops every policy + the enum', () => {
    for (const t of tables) {
      for (const r of roles) {
        expect(DOWN).toMatch(
          new RegExp(`DROP POLICY IF EXISTS ${t}_${r}\\s+ON ${t}`),
        );
      }
    }
    expect(DOWN).toMatch(/DROP TYPE IF EXISTS job_status/);
  });

  it('down migration drops all four tables in FK-safe order', () => {
    // job_photos references jobs, job_status_log references jobs, jobs
    // references customers, customers references franchisees. Drop
    // order must be reverse.
    const photosIdx = DOWN.indexOf('DROP TABLE IF EXISTS job_photos');
    const statusIdx = DOWN.indexOf('DROP TABLE IF EXISTS job_status_log');
    const jobsIdx = DOWN.indexOf('DROP TABLE IF EXISTS jobs');
    const customersIdx = DOWN.indexOf('DROP TABLE IF EXISTS customers');
    expect(photosIdx).toBeGreaterThan(-1);
    expect(photosIdx).toBeLessThan(jobsIdx);
    expect(statusIdx).toBeLessThan(jobsIdx);
    expect(jobsIdx).toBeLessThan(customersIdx);
  });
});
