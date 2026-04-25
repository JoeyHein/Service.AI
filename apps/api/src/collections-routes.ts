/**
 * AI collections endpoints (TASK-CO-04 + CO-05 + CO-06).
 *
 *   POST /api/v1/collections/run                         sweep
 *   GET  /api/v1/collections/drafts?status=              list
 *   POST /api/v1/collections/drafts/:id/approve          send
 *   POST /api/v1/collections/drafts/:id/edit             replace body
 *   POST /api/v1/collections/drafts/:id/reject           reject
 *   GET  /api/v1/collections/metrics                     DSO + recovered
 *   POST /api/v1/payments/retries/:id/run                admin retry
 *
 * Role gate: collections dispatch-role (franchisee_owner,
 * location_manager, dispatcher) + admins. Tech / CSR → 403.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  collectionsDrafts,
  invoices,
  paymentRetries,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { AIClient } from '@service-ai/ai';
import type { EmailSender, SmsSender } from './notify.js';
import type { StripeClient } from './stripe.js';
import {
  runCollectionsSweep,
  computeCollectionsMetrics,
} from './ai-collections.js';
import { logger } from './logger.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CollectionsRouteDeps {
  ai: AIClient;
  emailSender: EmailSender;
  smsSender: SmsSender;
  stripe: StripeClient;
  publicBaseUrl: string;
}

const COLLECTIONS_ROLES = new Set([
  'franchisee_owner',
  'location_manager',
  'dispatcher',
]);

function canCollect(scope: RequestScope): boolean {
  if (scope.type === 'platform' || scope.type === 'franchisor') return true;
  if (scope.type === 'franchisee' && COLLECTIONS_ROLES.has(scope.role))
    return true;
  return false;
}

function scopedFranchiseeId(scope: RequestScope): string | null {
  if (scope.type === 'platform' || scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

const StatusFilter = z.enum([
  'pending',
  'approved',
  'edited',
  'rejected',
  'sent',
  'failed',
]);

const EditBody = z.object({
  smsBody: z.string().min(1).max(2000).optional(),
  emailSubject: z.string().min(1).max(200).optional(),
  emailBody: z.string().min(1).max(5000).optional(),
  tone: z.enum(['friendly', 'firm', 'final']).optional(),
});

export function registerCollectionsRoutes(
  app: FastifyInstance,
  db: Drizzle,
  deps: CollectionsRouteDeps,
): void {
  // ----- POST /collections/run ---------------------------------------------
  app.post('/api/v1/collections/run', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (!canCollect(scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Collections permission required' },
      });
    }
    if (scope.type !== 'franchisee') {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Impersonate a franchisee to trigger a sweep',
        },
      });
    }
    const result = await runCollectionsSweep(
      { db, ai: deps.ai },
      {
        scope,
        franchiseeId: scope.franchiseeId,
        publicBaseUrl: deps.publicBaseUrl,
      },
    );
    return reply.code(201).send({ ok: true, data: result });
  });

  // ----- GET /collections/drafts -------------------------------------------
  app.get('/api/v1/collections/drafts', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (!canCollect(scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Collections permission required' },
      });
    }
    const q = req.query as Record<string, string | undefined>;
    const statusParsed = q['status']
      ? StatusFilter.safeParse(q['status'])
      : null;
    if (statusParsed && !statusParsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'invalid status' },
      });
    }
    const feScope = scopedFranchiseeId(scope);
    const rows = await withScope(db, scope, (tx) => {
      const conditions: unknown[] = [];
      if (feScope)
        conditions.push(eq(collectionsDrafts.franchiseeId, feScope));
      if (statusParsed && statusParsed.success)
        conditions.push(eq(collectionsDrafts.status, statusParsed.data));
      const where =
        conditions.length > 0
          ? and(...(conditions as Parameters<typeof and>))
          : undefined;
      const base = tx
        .select()
        .from(collectionsDrafts)
        .orderBy(desc(collectionsDrafts.createdAt));
      return where ? base.where(where) : base;
    });
    return reply.code(200).send({ ok: true, data: { rows } });
  });

  // ----- POST /collections/drafts/:id/approve ------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/collections/drafts/:id/approve',
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
      if (!canCollect(scope)) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Collections permission required' },
        });
      }
      const userId = req.userId;
      const feScope = scopedFranchiseeId(scope);

      type Outcome =
        | { kind: 'not_found' }
        | { kind: 'bad_state'; status: string }
        | {
            kind: 'ok';
            row: typeof collectionsDrafts.$inferSelect;
            customerEmail: string | null;
            customerPhone: string | null;
          };

      const outcome = await withScope(db, scope, async (tx): Promise<Outcome> => {
        const draftRows = await tx
          .select()
          .from(collectionsDrafts)
          .where(eq(collectionsDrafts.id, req.params.id));
        const draft = draftRows[0];
        if (!draft) return { kind: 'not_found' };
        if (feScope && draft.franchiseeId !== feScope)
          return { kind: 'not_found' };
        if (scope.type === 'franchisor') {
          const feRows = await tx
            .select({ franchisorId: schema.franchisees.franchisorId })
            .from(schema.franchisees)
            .where(eq(schema.franchisees.id, draft.franchiseeId));
          if (feRows[0]?.franchisorId !== scope.franchisorId)
            return { kind: 'not_found' };
        }
        if (draft.status !== 'pending' && draft.status !== 'edited')
          return { kind: 'bad_state', status: draft.status };

        const invRows = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, draft.invoiceId));
        const invoice = invRows[0];
        const customerRows = invoice
          ? await tx
              .select()
              .from(schema.customers)
              .where(eq(schema.customers.id, invoice.customerId))
          : [];
        const customer = customerRows[0] ?? null;
        return {
          kind: 'ok',
          row: draft,
          customerEmail: customer?.email ?? null,
          customerPhone: customer?.phone ?? null,
        };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Draft not found' },
        });
      }
      if (outcome.kind === 'bad_state') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'DRAFT_NOT_PENDING',
            message: `Draft is already ${outcome.status}`,
          },
        });
      }
      // Fire the sends outside the transaction so a provider hiccup
      // doesn't leave a half-sent row.
      const channels: Array<'email' | 'sms'> = [];
      const channelsCfg = outcome.row.deliveryChannels as {
        email?: boolean;
        sms?: boolean;
      };
      const sendContext = {
        franchiseeId: outcome.row.franchiseeId,
        invoiceId: outcome.row.invoiceId,
        relatedKind: 'collections',
      };
      if (channelsCfg.email !== false && outcome.customerEmail) {
        try {
          await deps.emailSender.send({
            to: outcome.customerEmail,
            subject: outcome.row.emailSubject,
            text: outcome.row.emailBody,
            tag: 'collections-send',
            context: sendContext,
          });
          channels.push('email');
        } catch (err) {
          logger.error({ err }, 'collections email send failed');
        }
      }
      if (channelsCfg.sms !== false && outcome.customerPhone) {
        try {
          await deps.smsSender.send({
            to: outcome.customerPhone,
            body: outcome.row.smsBody,
            tag: 'collections-send',
            context: sendContext,
          });
          channels.push('sms');
        } catch (err) {
          logger.error({ err }, 'collections sms send failed');
        }
      }
      const now = new Date();
      const updated = await withScope(db, scope, async (tx) =>
        tx
          .update(collectionsDrafts)
          .set({
            status: channels.length > 0 ? 'sent' : 'failed',
            decidedAt: now,
            decidedByUserId: userId ?? null,
            sentAt: channels.length > 0 ? now : null,
            deliveryChannels: { email: channels.includes('email'), sms: channels.includes('sms') },
            updatedAt: now,
          })
          .where(eq(collectionsDrafts.id, outcome.row.id))
          .returning(),
      );
      return reply.code(200).send({
        ok: true,
        data: { ...updated[0]!, channels },
      });
    },
  );

  // ----- POST /collections/drafts/:id/edit ---------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/collections/drafts/:id/edit',
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
      const parsed = EditBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      if (!canCollect(scope)) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Collections permission required' },
        });
      }
      const userId = req.userId;
      const feScope = scopedFranchiseeId(scope);
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(collectionsDrafts)
          .where(eq(collectionsDrafts.id, req.params.id));
        const draft = rows[0];
        if (!draft) return { kind: 'not_found' as const };
        if (feScope && draft.franchiseeId !== feScope)
          return { kind: 'not_found' as const };
        if (scope.type === 'franchisor') {
          const feRows = await tx
            .select({ franchisorId: schema.franchisees.franchisorId })
            .from(schema.franchisees)
            .where(eq(schema.franchisees.id, draft.franchiseeId));
          if (feRows[0]?.franchisorId !== scope.franchisorId)
            return { kind: 'not_found' as const };
        }
        if (draft.status !== 'pending' && draft.status !== 'edited')
          return { kind: 'bad_state' as const, status: draft.status };

        const values: Record<string, unknown> = {
          status: 'edited',
          decidedAt: new Date(),
          decidedByUserId: userId ?? null,
          updatedAt: new Date(),
        };
        if (parsed.data.smsBody !== undefined) values.smsBody = parsed.data.smsBody;
        if (parsed.data.emailSubject !== undefined)
          values.emailSubject = parsed.data.emailSubject;
        if (parsed.data.emailBody !== undefined)
          values.emailBody = parsed.data.emailBody;
        if (parsed.data.tone !== undefined) values.tone = parsed.data.tone;
        const updated = await tx
          .update(collectionsDrafts)
          .set(values)
          .where(eq(collectionsDrafts.id, draft.id))
          .returning();
        return { kind: 'ok' as const, row: updated[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Draft not found' },
        });
      }
      if (outcome.kind === 'bad_state') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'DRAFT_NOT_PENDING',
            message: `Draft is already ${outcome.status}`,
          },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );

  // ----- POST /collections/drafts/:id/reject -------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/collections/drafts/:id/reject',
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
      if (!canCollect(scope)) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Collections permission required' },
        });
      }
      const userId = req.userId;
      const feScope = scopedFranchiseeId(scope);
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(collectionsDrafts)
          .where(eq(collectionsDrafts.id, req.params.id));
        const draft = rows[0];
        if (!draft) return { kind: 'not_found' as const };
        if (feScope && draft.franchiseeId !== feScope)
          return { kind: 'not_found' as const };
        if (draft.status !== 'pending' && draft.status !== 'edited')
          return { kind: 'bad_state' as const, status: draft.status };
        const updated = await tx
          .update(collectionsDrafts)
          .set({
            status: 'rejected',
            decidedAt: new Date(),
            decidedByUserId: userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(collectionsDrafts.id, draft.id))
          .returning();
        return { kind: 'ok' as const, row: updated[0]! };
      });
      if (outcome.kind === 'not_found')
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Draft not found' },
        });
      if (outcome.kind === 'bad_state')
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'DRAFT_NOT_PENDING',
            message: `Draft is already ${outcome.status}`,
          },
        });
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );

  // ----- GET /collections/metrics ------------------------------------------
  app.get('/api/v1/collections/metrics', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (!canCollect(scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Collections permission required' },
      });
    }
    if (scope.type !== 'franchisee') {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Impersonate a franchisee to read metrics',
        },
      });
    }
    const m = await withScope(db, scope, (tx) =>
      computeCollectionsMetrics(tx, {
        franchiseeId: scope.franchiseeId,
      }),
    );
    return reply.code(200).send({ ok: true, data: m });
  });

  // ----- POST /payments/retries/:id/run ------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/payments/retries/:id/run',
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
      if (!canCollect(scope)) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Collections permission required' },
        });
      }
      const feScope = scopedFranchiseeId(scope);
      type Outcome =
        | { kind: 'not_found' }
        | { kind: 'bad_state'; status: string }
        | { kind: 'ok'; retry: typeof paymentRetries.$inferSelect; invoice: typeof invoices.$inferSelect };

      const outcome = await withScope(db, scope, async (tx): Promise<Outcome> => {
        const rows = await tx
          .select()
          .from(paymentRetries)
          .where(eq(paymentRetries.id, req.params.id));
        const retry = rows[0];
        if (!retry) return { kind: 'not_found' };
        if (feScope && retry.franchiseeId !== feScope)
          return { kind: 'not_found' };
        if (retry.status !== 'scheduled')
          return { kind: 'bad_state', status: retry.status };
        const invRows = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, retry.invoiceId));
        const invoice = invRows[0];
        if (!invoice) return { kind: 'not_found' };
        return { kind: 'ok', retry, invoice };
      });
      if (outcome.kind === 'not_found')
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Retry not found' },
        });
      if (outcome.kind === 'bad_state')
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'RETRY_NOT_SCHEDULED',
            message: `Retry is already ${outcome.status}`,
          },
        });

      // Fire the Stripe call outside the scope transaction.
      let status: 'succeeded' | 'failed' = 'failed';
      let resultRef: Record<string, unknown> = {};
      try {
        const feRows = await db
          .select()
          .from(schema.franchisees)
          .where(eq(schema.franchisees.id, outcome.invoice.franchiseeId));
        const fe = feRows[0];
        if (!fe?.stripeAccountId) {
          resultRef = { error: 'stripe_not_ready' };
        } else {
          const totalCents = Math.round(Number(outcome.invoice.total) * 100);
          const feeCents = Math.round(
            Number(outcome.invoice.applicationFeeAmount) * 100,
          );
          const pi = await deps.stripe.createPaymentIntent({
            amount: totalCents,
            applicationFeeAmount: feeCents,
            currency: 'usd',
            onBehalfOf: fe.stripeAccountId,
            transferDestination: fe.stripeAccountId,
            metadata: {
              invoiceId: outcome.invoice.id,
              retryId: outcome.retry.id,
            },
          });
          resultRef = { paymentIntentId: pi.id, status: pi.status };
          status = 'succeeded';
        }
      } catch (err) {
        resultRef = {
          error: err instanceof Error ? err.message : 'unknown',
        };
      }
      const updated = await withScope(db, scope, async (tx) =>
        tx
          .update(paymentRetries)
          .set({
            status,
            resultRef,
            updatedAt: new Date(),
          })
          .where(eq(paymentRetries.id, outcome.retry.id))
          .returning(),
      );
      return reply.code(200).send({ ok: true, data: updated[0] });
    },
  );
}
