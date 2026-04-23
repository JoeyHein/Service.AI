/**
 * Job photo upload + gallery (TASK-CJ-07).
 *
 *   POST   /api/v1/jobs/:id/photos/upload-url   request presigned PUT
 *   POST   /api/v1/jobs/:id/photos              finalise photo record
 *   GET    /api/v1/jobs/:id/photos              list photos + download URLs
 *   DELETE /api/v1/jobs/:id/photos/:photoId     remove photo row
 *
 * Every endpoint verifies the job is in scope before acting. Client
 * flow:
 *   1. POST /upload-url to reserve a storage_key + short-lived PUT URL
 *   2. PUT bytes directly to uploadUrl (browser → DO Spaces; skips
 *      the API, so large photos don't go through the server)
 *   3. POST /photos to finalise the metadata (storage_key + size)
 *
 * Storage cleanup on DELETE is intentionally deferred to a later phase
 * (tracked in docs/TECH_DEBT.md) so orphaned objects do not block the
 * happy path here; v2 adds a lifecycle rule on the bucket.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { jobs, jobPhotos, withScope, type RequestScope } from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { ObjectStore } from './object-store.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UploadUrlSchema = z.object({
  contentType: z.string().min(3).max(120),
  label: z.string().max(50).nullable().optional(),
  extension: z
    .string()
    .regex(/^[a-z0-9]{1,8}$/i, 'extension must be alphanumeric, 1-8 chars')
    .default('jpg'),
});

const FinaliseSchema = z.object({
  storageKey: z.string().min(5),
  contentType: z.string().min(3).max(120),
  sizeBytes: z.number().int().positive().max(50_000_000),
  label: z.string().max(50).nullable().optional(),
});

function scopedFranchiseeId(scope: RequestScope): string | null {
  if (scope.type === 'platform' || scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

async function loadJobInScope(
  db: Drizzle,
  scope: RequestScope,
  jobId: string,
): Promise<{ id: string; franchiseeId: string } | null> {
  const rows = await db
    .select({ id: jobs.id, franchiseeId: jobs.franchiseeId, deletedAt: jobs.deletedAt })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  const row = rows[0];
  if (!row || row.deletedAt !== null) return null;
  const fe = scopedFranchiseeId(scope);
  if (fe && row.franchiseeId !== fe) return null;
  if (scope.type === 'franchisor') {
    const feRows = await db
      .select({ franchisorId: schema.franchisees.franchisorId })
      .from(schema.franchisees)
      .where(eq(schema.franchisees.id, row.franchiseeId));
    if (feRows[0]?.franchisorId !== scope.franchisorId) return null;
  }
  return { id: row.id, franchiseeId: row.franchiseeId };
}

export function registerJobPhotoRoutes(
  app: FastifyInstance,
  db: Drizzle,
  store: ObjectStore,
): void {
  // -------------------------------------------------------------------------
  // POST /api/v1/jobs/:id/photos/upload-url
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/jobs/:id/photos/upload-url',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = UploadUrlSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const job = await loadJobInScope(db, req.scope, req.params.id);
      if (!job) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      const photoId = randomUUID();
      const storageKey = `jobs/${req.params.id}/photos/${photoId}.${parsed.data.extension}`;
      const upload = await store.getUploadUrl(storageKey, parsed.data.contentType);
      return reply.code(200).send({ ok: true, data: upload });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/jobs/:id/photos — finalise
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/photos', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
      });
    }
    const parsed = FinaliseSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const job = await loadJobInScope(db, req.scope, req.params.id);
    if (!job) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }
    if (!parsed.data.storageKey.startsWith(`jobs/${req.params.id}/photos/`)) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'INVALID_TARGET',
          message: 'storageKey does not belong to this job',
        },
      });
    }
    const scope = req.scope;
    const inserted = await withScope(db, scope, (tx) =>
      tx
        .insert(jobPhotos)
        .values({
          jobId: req.params.id,
          franchiseeId: job.franchiseeId,
          storageKey: parsed.data.storageKey,
          contentType: parsed.data.contentType,
          sizeBytes: parsed.data.sizeBytes,
          label: parsed.data.label ?? null,
          uploadedByUserId: req.userId,
        })
        .returning(),
    );
    const row = inserted[0]!;
    const downloadUrl = await store.getDownloadUrl(row.storageKey);
    return reply.code(201).send({ ok: true, data: { ...row, downloadUrl } });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/jobs/:id/photos
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id/photos', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
      });
    }
    const job = await loadJobInScope(db, req.scope, req.params.id);
    if (!job) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }
    const scope = req.scope;
    const rows = await withScope(db, scope, (tx) =>
      tx
        .select()
        .from(jobPhotos)
        .where(eq(jobPhotos.jobId, req.params.id))
        .orderBy(desc(jobPhotos.createdAt)),
    );
    const withUrls = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        downloadUrl: await store.getDownloadUrl(r.storageKey),
      })),
    );
    return reply.code(200).send({ ok: true, data: withUrls });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/jobs/:id/photos/:photoId
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; photoId: string } }>(
    '/api/v1/jobs/:id/photos/:photoId',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.photoId)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const job = await loadJobInScope(db, req.scope, req.params.id);
      if (!job) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      const scope = req.scope;
      const deleted = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select({ id: jobPhotos.id })
          .from(jobPhotos)
          .where(
            and(
              eq(jobPhotos.id, req.params.photoId),
              eq(jobPhotos.jobId, req.params.id),
            ),
          );
        if (rows.length === 0) return false;
        await tx.delete(jobPhotos).where(eq(jobPhotos.id, req.params.photoId));
        return true;
      });
      if (!deleted) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Photo not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: { deleted: true } });
    },
  );
}
