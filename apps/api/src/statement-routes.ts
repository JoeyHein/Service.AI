/**
 * Royalty statement endpoints (TASK-RE-05).
 *
 *   POST /api/v1/franchisees/:id/statements/generate { month, year, timezone? }
 *     Admin-only; wraps generateMonthlyStatement + upserts.
 *   GET  /api/v1/franchisees/:id/statements
 *     Lists a franchisee's statements; visible to admins + the
 *     franchisee itself.
 *   GET  /api/v1/statements (franchisee-scope convenience) — lists
 *     the caller's franchisee statements (for the /statements
 *     franchisee UI in RE-07).
 *   POST /api/v1/statements/:id/reconcile
 *     Creates a Stripe Transfer for the statement's variance and
 *     flips status to 'reconciled'. Admin-only.
 */

import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  franchisees,
  royaltyStatements,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { StripeClient } from './stripe.js';
import { generateMonthlyStatement } from './royalty-statement.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GenerateBody = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  timezone: z.string().min(1).max(100).optional(),
});

interface StatementDeps {
  stripe: StripeClient;
}

function canAdminFranchisee(scope: RequestScope, franchisorId: string): boolean {
  if (scope.type === 'platform') return true;
  if (scope.type === 'franchisor' && scope.franchisorId === franchisorId)
    return true;
  return false;
}

function canReadFranchisee(
  scope: RequestScope,
  franchisorId: string,
  franchiseeId: string,
): boolean {
  if (canAdminFranchisee(scope, franchisorId)) return true;
  if (scope.type === 'franchisee' && scope.franchiseeId === franchiseeId)
    return true;
  return false;
}

async function loadFranchisee(tx: ScopedTx, id: string) {
  const rows = await tx.select().from(franchisees).where(eq(franchisees.id, id));
  return rows[0] ?? null;
}

export function registerStatementRoutes(
  app: FastifyInstance,
  db: Drizzle,
  deps: StatementDeps,
): void {
  // ----- POST generate --------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/franchisees/:id/statements/generate',
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
      const parsed = GenerateBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const fe = await loadFranchisee(tx, req.params.id);
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };
        const statement = await generateMonthlyStatement(tx, {
          franchiseeId: fe.id,
          year: parsed.data.year,
          month: parsed.data.month,
          timezone: parsed.data.timezone,
        });
        return { kind: 'ok' as const, statement };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
        });
      }
      if (outcome.kind === 'forbidden') {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin-only' },
        });
      }
      return reply.code(201).send({ ok: true, data: outcome.statement });
    },
  );

  // ----- GET franchisee's statements -----------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/v1/franchisees/:id/statements',
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
      const outcome = await withScope(db, scope, async (tx) => {
        const fe = await loadFranchisee(tx, req.params.id);
        if (!fe) return { kind: 'not_found' as const };
        if (!canReadFranchisee(scope, fe.franchisorId, fe.id))
          return { kind: 'not_found' as const };
        const rows = await tx
          .select()
          .from(royaltyStatements)
          .where(eq(royaltyStatements.franchiseeId, fe.id))
          .orderBy(desc(royaltyStatements.periodStart));
        return { kind: 'ok' as const, rows };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: { rows: outcome.rows } });
    },
  );

  // ----- GET caller's franchisee statements (RE-07 UI) -----------------------
  app.get('/api/v1/statements', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    const rows = await withScope(db, scope, (tx) => {
      const base = tx
        .select()
        .from(royaltyStatements)
        .orderBy(desc(royaltyStatements.periodStart));
      if (scope.type === 'platform') return base;
      if (scope.type === 'franchisor') {
        return base.where(eq(royaltyStatements.franchisorId, scope.franchisorId));
      }
      return base.where(eq(royaltyStatements.franchiseeId, scope.franchiseeId));
    });
    return reply.code(200).send({ ok: true, data: { rows } });
  });

  // ----- POST reconcile ------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/statements/:id/reconcile',
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
      type Outcome =
        | { kind: 'not_found' }
        | { kind: 'forbidden' }
        | { kind: 'already' }
        | { kind: 'no_account' }
        | { kind: 'no_variance' }
        | { kind: 'ok'; statement: typeof royaltyStatements.$inferSelect };

      const outcome = await withScope(db, scope, async (tx): Promise<Outcome> => {
        const rows = await tx
          .select()
          .from(royaltyStatements)
          .where(eq(royaltyStatements.id, req.params.id));
        const statement = rows[0];
        if (!statement) return { kind: 'not_found' };
        const feRows = await tx
          .select()
          .from(franchisees)
          .where(eq(franchisees.id, statement.franchiseeId));
        const fe = feRows[0];
        if (!fe) return { kind: 'not_found' };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' };
        if (statement.status === 'reconciled') return { kind: 'already' };
        if (!fe.stripeAccountId) return { kind: 'no_account' };
        const varianceCents = Math.round(Number(statement.variance) * 100);
        if (varianceCents === 0) {
          const updated = await tx
            .update(royaltyStatements)
            .set({ status: 'reconciled', updatedAt: new Date() })
            .where(eq(royaltyStatements.id, statement.id))
            .returning();
          return { kind: 'ok', statement: updated[0]! };
        }

        // `variance` is owed - collected. Positive → franchisee owes
        // the platform; we reclaim by creating a transfer FROM the
        // connected account (negative amount convention). Stripe
        // Standard uses actual account-to-platform transfers, so we
        // record an `acct_*` destination and the business operator
        // follows up via the dashboard. For now: always positive
        // `amount` in the transfer call, sign-encoded by description.
        const transfer = await deps.stripe.createTransfer({
          amount: Math.abs(varianceCents),
          currency: 'usd',
          destination: fe.stripeAccountId,
          description:
            varianceCents > 0
              ? 'Royalty reconciliation (franchisee → platform)'
              : 'Royalty adjustment (platform → franchisee)',
          metadata: {
            statementId: statement.id,
            franchiseeId: fe.id,
            variance: varianceCents.toString(),
          },
        });
        const updated = await tx
          .update(royaltyStatements)
          .set({
            status: 'reconciled',
            transferId: transfer.id,
            updatedAt: new Date(),
          })
          .where(eq(royaltyStatements.id, statement.id))
          .returning();
        return { kind: 'ok', statement: updated[0]! };
      });

      if (outcome.kind === 'not_found')
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Statement not found' },
        });
      if (outcome.kind === 'forbidden')
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin-only' },
        });
      if (outcome.kind === 'already')
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'ALREADY_RECONCILED',
            message: 'Statement already reconciled',
          },
        });
      if (outcome.kind === 'no_account')
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'STRIPE_NOT_READY',
            message: 'Franchisee has no connected account',
          },
        });
      if (outcome.kind === 'no_variance')
        return reply.code(200).send({ ok: true, data: null });
      return reply.code(200).send({ ok: true, data: outcome.statement });
    },
  );
}
