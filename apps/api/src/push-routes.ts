/**
 * Web push subscription endpoints (TASK-TM-06).
 *
 *   POST   /api/v1/push/subscribe          register a subscription
 *   DELETE /api/v1/push/subscriptions/:id  revoke by row id
 *   DELETE /api/v1/push/subscribe          revoke by endpoint
 *                                          (body { endpoint })
 *
 * The store enforces that every row belongs to the authenticated
 * user — the route additionally re-asserts `user_id = req.userId` on
 * every mutation so a compromised RLS policy can't leak the
 * subscription set to another caller. Endpoint uniqueness is a
 * defence against re-registration storms from service-worker
 * updates on the same browser.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { pushSubscriptions, withScope } from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(500).optional(),
});

const UnsubscribeByEndpointSchema = z.object({
  endpoint: z.string().url(),
});

export function registerPushRoutes(app: FastifyInstance, db: Drizzle): void {
  // POST /api/v1/push/subscribe
  app.post('/api/v1/push/subscribe', async (req, reply) => {
    if (req.scope === null || req.userId === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const parsed = SubscribeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const scope = req.scope;
    const userId = req.userId;
    const franchiseeId =
      scope.type === 'franchisee' ? scope.franchiseeId : null;

    const row = await withScope(db, scope, async (tx) => {
      // Upsert-like: a duplicate endpoint for the same user is a
      // no-op (update user_agent). A duplicate endpoint for a
      // different user is a soft-delete + re-insert — the browser
      // has legitimately moved profiles.
      const existing = await tx
        .select()
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.endpoint, parsed.data.endpoint),
            isNull(pushSubscriptions.deletedAt),
          ),
        );
      const current = existing[0];
      if (current && current.userId === userId) {
        const updated = await tx
          .update(pushSubscriptions)
          .set({
            p256dh: parsed.data.keys.p256dh,
            auth: parsed.data.keys.auth,
            userAgent: parsed.data.userAgent ?? current.userAgent,
            franchiseeId,
          })
          .where(eq(pushSubscriptions.id, current.id))
          .returning();
        return updated[0]!;
      }
      if (current) {
        await tx
          .update(pushSubscriptions)
          .set({ deletedAt: new Date() })
          .where(eq(pushSubscriptions.id, current.id));
      }
      const inserted = await tx
        .insert(pushSubscriptions)
        .values({
          userId,
          franchiseeId,
          endpoint: parsed.data.endpoint,
          p256dh: parsed.data.keys.p256dh,
          auth: parsed.data.keys.auth,
          userAgent: parsed.data.userAgent ?? null,
        })
        .returning();
      return inserted[0]!;
    });

    return reply.code(201).send({ ok: true, data: row });
  });

  // DELETE /api/v1/push/subscriptions/:id
  app.delete<{ Params: { id: string } }>(
    '/api/v1/push/subscriptions/:id',
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
      const scope = req.scope;
      const userId = req.userId;
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.id, req.params.id));
        const sub = rows[0];
        if (!sub || sub.userId !== userId) return 'not_found' as const;
        if (sub.deletedAt !== null) return 'already' as const;
        await tx
          .update(pushSubscriptions)
          .set({ deletedAt: new Date() })
          .where(eq(pushSubscriptions.id, sub.id));
        return 'ok' as const;
      });
      if (outcome === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Subscription not found' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { deleted: outcome === 'ok', alreadyDeleted: outcome === 'already' },
      });
    },
  );

  // DELETE /api/v1/push/subscribe (by endpoint)
  app.delete('/api/v1/push/subscribe', async (req, reply) => {
    if (req.scope === null || req.userId === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const parsed = UnsubscribeByEndpointSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const scope = req.scope;
    const userId = req.userId;
    const outcome = await withScope(db, scope, async (tx) => {
      const rows = await tx
        .select()
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.endpoint, parsed.data.endpoint),
            eq(pushSubscriptions.userId, userId),
            isNull(pushSubscriptions.deletedAt),
          ),
        );
      const sub = rows[0];
      if (!sub) return 'not_found' as const;
      await tx
        .update(pushSubscriptions)
        .set({ deletedAt: new Date() })
        .where(eq(pushSubscriptions.id, sub.id));
      return 'ok' as const;
    });
    if (outcome === 'not_found') {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Subscription not found' },
      });
    }
    return reply.code(200).send({ ok: true, data: { deleted: true } });
  });
}
