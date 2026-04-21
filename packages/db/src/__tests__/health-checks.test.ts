/**
 * Integration tests for TASK-FND-02: Drizzle + Postgres setup with health_checks table.
 *
 * These tests encode the acceptance criteria as executable specifications:
 *   - The Drizzle schema exposes the correct column names (camelCase).
 *   - The up migration SQL file creates the health_checks table.
 *   - The down migration SQL file drops the health_checks table.
 *   - Rows can be written to and read back from the live Postgres instance.
 *
 * Tests MUST fail until the builder provides:
 *   packages/db/src/schema.ts
 *   packages/db/src/client.ts
 *   packages/db/migrations/0001_health_checks.sql
 *   packages/db/migrations/0001_health_checks.down.sql
 *   packages/db/drizzle.config.ts
 */

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pkg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'

const { Pool } = pkg

// Resolve migration paths relative to the package root (two levels above src/__tests__)
const PACKAGE_ROOT = resolve(__dirname, '..', '..')
const UP_MIGRATION_PATH = resolve(PACKAGE_ROOT, 'migrations', '0001_health_checks.sql')
const DOWN_MIGRATION_PATH = resolve(PACKAGE_ROOT, 'migrations', '0001_health_checks.down.sql')

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://builder:builder@localhost:5434/servicetitan'

// ---------------------------------------------------------------------------
// 1. Schema shape tests — verify the Drizzle schema exposes expected columns
// ---------------------------------------------------------------------------

describe('health_checks Drizzle schema', () => {
  it('exports a healthChecks table object from schema.ts', async () => {
    // This import will throw at module resolution time if schema.ts does not exist.
    const schema = await import('../schema.js')
    expect(schema.healthChecks).toBeDefined()
  })

  it('healthChecks table has an "id" column', async () => {
    const { healthChecks } = await import('../schema.js')
    // Drizzle column definitions are accessible as object keys on the table.
    expect(Object.keys(healthChecks)).toContain('id')
  })

  it('healthChecks table has a "service" column', async () => {
    const { healthChecks } = await import('../schema.js')
    expect(Object.keys(healthChecks)).toContain('service')
  })

  it('healthChecks table has a "status" column', async () => {
    const { healthChecks } = await import('../schema.js')
    expect(Object.keys(healthChecks)).toContain('status')
  })

  it('healthChecks table has a "checkedAt" column (camelCase per Drizzle convention)', async () => {
    const { healthChecks } = await import('../schema.js')
    expect(Object.keys(healthChecks)).toContain('checkedAt')
  })
})

// ---------------------------------------------------------------------------
// 2. Up-migration SQL tests — verify the file creates the expected table
// ---------------------------------------------------------------------------

describe('up migration SQL (0001_health_checks.sql)', () => {
  it('migration file exists and is readable', () => {
    // readFileSync throws if the file does not exist — test fails as expected.
    const sql = readFileSync(UP_MIGRATION_PATH, 'utf8')
    expect(sql.length).toBeGreaterThan(0)
  })

  it('migration SQL contains CREATE TABLE statement', () => {
    const sql = readFileSync(UP_MIGRATION_PATH, 'utf8')
    expect(sql.toUpperCase()).toMatch(/CREATE TABLE/)
  })

  it('migration SQL references the health_checks table name', () => {
    const sql = readFileSync(UP_MIGRATION_PATH, 'utf8')
    expect(sql).toMatch(/health_checks/)
  })

  it('migration SQL defines an id column', () => {
    const sql = readFileSync(UP_MIGRATION_PATH, 'utf8')
    // Must mention the id column and uuid type.
    expect(sql).toMatch(/\bid\b/)
    expect(sql.toLowerCase()).toMatch(/uuid/)
  })

  it('migration SQL defines a service column as varchar(100)', () => {
    const sql = readFileSync(UP_MIGRATION_PATH, 'utf8')
    expect(sql).toMatch(/\bservice\b/)
    expect(sql.toLowerCase()).toMatch(/varchar\s*\(\s*100\s*\)/)
  })

  it('migration SQL defines a status column as varchar(20)', () => {
    const sql = readFileSync(UP_MIGRATION_PATH, 'utf8')
    expect(sql).toMatch(/\bstatus\b/)
    expect(sql.toLowerCase()).toMatch(/varchar\s*\(\s*20\s*\)/)
  })

  it('migration SQL defines a checked_at column', () => {
    const sql = readFileSync(UP_MIGRATION_PATH, 'utf8')
    expect(sql).toMatch(/checked_at/)
  })
})

// ---------------------------------------------------------------------------
// 3. Down-migration SQL tests — verify the file drops the table
// ---------------------------------------------------------------------------

describe('down migration SQL (0001_health_checks.down.sql)', () => {
  it('down migration file exists and is readable', () => {
    const sql = readFileSync(DOWN_MIGRATION_PATH, 'utf8')
    expect(sql.length).toBeGreaterThan(0)
  })

  it('down migration SQL contains DROP TABLE statement', () => {
    const sql = readFileSync(DOWN_MIGRATION_PATH, 'utf8')
    expect(sql.toUpperCase()).toMatch(/DROP TABLE/)
  })

  it('down migration SQL references the health_checks table name', () => {
    const sql = readFileSync(DOWN_MIGRATION_PATH, 'utf8')
    expect(sql).toMatch(/health_checks/)
  })
})

// ---------------------------------------------------------------------------
// 4. Live integration: write + read a health_checks row via Drizzle ORM
// ---------------------------------------------------------------------------

describe('health_checks live integration', () => {
  let pool: InstanceType<typeof Pool>

  afterAll(async () => {
    if (pool) {
      await pool.end()
    }
  })

  it(
    'applies the up migration, inserts a row, reads it back, then cleans up',
    async () => {
      // Step 1: establish connection.
      pool = new Pool({ connectionString: DATABASE_URL })

      // Step 2: apply the up migration idempotently so the table exists.
      const upSql = readFileSync(UP_MIGRATION_PATH, 'utf8')
      // Convert any plain CREATE TABLE to CREATE TABLE IF NOT EXISTS so re-runs do not error.
      const idempotentSql = upSql.replace(
        /CREATE TABLE\s+(?!IF NOT EXISTS)/gi,
        'CREATE TABLE IF NOT EXISTS ',
      )
      await pool.query(idempotentSql)

      // Step 3: build a Drizzle client using the live schema.
      const { healthChecks } = await import('../schema.js')
      const db = drizzle(pool, { schema: { healthChecks } })

      // Step 4: insert a representative row.
      const inserted = await db
        .insert(healthChecks)
        .values({
          service: 'api',
          status: 'up',
        })
        .returning()

      expect(inserted).toHaveLength(1)
      const row = inserted[0]

      // The row should have an auto-generated UUID id.
      expect(row.id).toBeDefined()
      expect(typeof row.id).toBe('string')
      expect(row.id.length).toBe(36) // standard UUID v4 string length

      expect(row.service).toBe('api')
      expect(row.status).toBe('up')
      // checked_at should be a Date populated by the database default.
      expect(row.checkedAt).toBeInstanceOf(Date)

      // Step 5: read the row back by its id to confirm round-trip persistence.
      const fetched = await db
        .select()
        .from(healthChecks)
        .where(eq(healthChecks.id, row.id))

      expect(fetched).toHaveLength(1)
      expect(fetched[0].service).toBe('api')
      expect(fetched[0].status).toBe('up')

      // Step 6: clean up — delete only the test row.
      const deleted = await db
        .delete(healthChecks)
        .where(eq(healthChecks.id, row.id))
        .returning()

      expect(deleted).toHaveLength(1)
      expect(deleted[0].id).toBe(row.id)
    },
    30_000, // allow up to 30 s for DB round-trips
  )

  it(
    'rejects a row with a service value exceeding 100 characters',
    async () => {
      pool = pool ?? new Pool({ connectionString: DATABASE_URL })

      const upSql = readFileSync(UP_MIGRATION_PATH, 'utf8')
      const idempotentSql = upSql.replace(
        /CREATE TABLE\s+(?!IF NOT EXISTS)/gi,
        'CREATE TABLE IF NOT EXISTS ',
      )
      await pool.query(idempotentSql)

      const { healthChecks } = await import('../schema.js')
      const db = drizzle(pool, { schema: { healthChecks } })

      const tooLongService = 'a'.repeat(101)

      await expect(
        db
          .insert(healthChecks)
          .values({
            service: tooLongService,
            status: 'up',
          })
          .returning(),
      ).rejects.toThrow()
    },
    30_000,
  )

  it(
    'rejects a row with a status value exceeding 20 characters',
    async () => {
      pool = pool ?? new Pool({ connectionString: DATABASE_URL })

      const upSql = readFileSync(UP_MIGRATION_PATH, 'utf8')
      const idempotentSql = upSql.replace(
        /CREATE TABLE\s+(?!IF NOT EXISTS)/gi,
        'CREATE TABLE IF NOT EXISTS ',
      )
      await pool.query(idempotentSql)

      const { healthChecks } = await import('../schema.js')
      const db = drizzle(pool, { schema: { healthChecks } })

      const tooLongStatus = 'degraded-but-also-somewhat-operational'

      await expect(
        db
          .insert(healthChecks)
          .values({
            service: 'api',
            status: tooLongStatus,
          })
          .returning(),
      ).rejects.toThrow()
    },
    30_000,
  )

  it(
    'defaults checked_at to the current timestamp when not supplied',
    async () => {
      pool = pool ?? new Pool({ connectionString: DATABASE_URL })

      const upSql = readFileSync(UP_MIGRATION_PATH, 'utf8')
      const idempotentSql = upSql.replace(
        /CREATE TABLE\s+(?!IF NOT EXISTS)/gi,
        'CREATE TABLE IF NOT EXISTS ',
      )
      await pool.query(idempotentSql)

      const { healthChecks } = await import('../schema.js')
      const db = drizzle(pool, { schema: { healthChecks } })

      const beforeInsert = new Date()

      const inserted = await db
        .insert(healthChecks)
        .values({ service: 'voice', status: 'up' })
        .returning()

      const afterInsert = new Date()
      const row = inserted[0]

      // checked_at must fall within the observed wall-clock window.
      expect(row.checkedAt.getTime()).toBeGreaterThanOrEqual(beforeInsert.getTime() - 2000)
      expect(row.checkedAt.getTime()).toBeLessThanOrEqual(afterInsert.getTime() + 2000)

      // Clean up.
      await db.delete(healthChecks).where(eq(healthChecks.id, row.id))
    },
    30_000,
  )
})
