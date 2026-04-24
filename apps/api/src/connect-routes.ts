/**
 * Stripe Connect Standard onboarding (TASK-IP-03).
 *
 *   POST /api/v1/franchisees/:id/connect/onboard
 *     Creates (or reuses) the franchisee's connected account,
 *     returns a fresh account link URL for the franchisor admin
 *     to hand to the franchisee. Account links expire in ~5 min
 *     so this endpoint is called every time the UI shows the
 *     onboarding button.
 *
 *   GET /api/v1/franchisees/:id/connect/status
 *     Syncs with Stripe, returns the three readiness booleans.
 *     Cheap and safe to call on every page load; the real client
 *     rate-limits at Stripe's side and the stub is free.
 *
 * Only platform_admin and the owning franchisor's franchisor_admin
 * may call these. Tech / dispatcher / CSR → 403 so a scoped user
 * cannot set up payment routing outside their authority.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { franchisees, withScope, type RequestScope } from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { StripeClient } from './stripe.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FranchiseeConnectDeps {
  stripe: StripeClient;
  /** Origin used to build Stripe redirect URLs. */
  publicBaseUrl: string;
}

function canAdminFranchisee(scope: RequestScope, franchisorId: string): boolean {
  if (scope.type === 'platform') return true;
  if (scope.type === 'franchisor' && scope.franchisorId === franchisorId)
    return true;
  return false;
}

export function registerConnectRoutes(
  app: FastifyInstance,
  db: Drizzle,
  deps: FranchiseeConnectDeps,
): void {
  // POST /api/v1/franchisees/:id/connect/onboard
  app.post<{ Params: { id: string } }>(
    '/api/v1/franchisees/:id/connect/onboard',
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
      const result = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(franchisees)
          .where(eq(franchisees.id, req.params.id));
        const fe = rows[0];
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };

        let accountId = fe.stripeAccountId;
        let summary;
        if (!accountId) {
          summary = await deps.stripe.createConnectAccount({
            franchiseeId: fe.id,
            legalName: fe.legalEntityName ?? fe.name,
          });
          accountId = summary.id;
          await tx
            .update(franchisees)
            .set({
              stripeAccountId: accountId,
              stripeChargesEnabled: summary.chargesEnabled,
              stripePayoutsEnabled: summary.payoutsEnabled,
              stripeDetailsSubmitted: summary.detailsSubmitted,
              updatedAt: new Date(),
            })
            .where(eq(franchisees.id, fe.id));
        }
        const returnUrl = `${deps.publicBaseUrl}/franchisor/franchisees/${fe.id}/billing?connect=return`;
        const refreshUrl = `${deps.publicBaseUrl}/franchisor/franchisees/${fe.id}/billing?connect=refresh`;
        const link = await deps.stripe.createAccountLink({
          accountId,
          returnUrl,
          refreshUrl,
        });
        return {
          kind: 'ok' as const,
          accountId,
          onboardingUrl: link.url,
          expiresAt: link.expiresAt,
        };
      });
      if (result.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
        });
      }
      if (result.kind === 'forbidden') {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Connect onboarding is admin-only' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: {
          accountId: result.accountId,
          onboardingUrl: result.onboardingUrl,
          expiresAt: result.expiresAt,
        },
      });
    },
  );

  // GET /api/v1/franchisees/:id/connect/status
  app.get<{ Params: { id: string } }>(
    '/api/v1/franchisees/:id/connect/status',
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
      const result = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(franchisees)
          .where(eq(franchisees.id, req.params.id));
        const fe = rows[0];
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };

        if (!fe.stripeAccountId) {
          return {
            kind: 'ok' as const,
            accountId: null,
            chargesEnabled: false,
            payoutsEnabled: false,
            detailsSubmitted: false,
          };
        }
        // Fetch fresh from Stripe + sync local columns.
        const summary = await deps.stripe.retrieveAccount(fe.stripeAccountId);
        const changed =
          summary.chargesEnabled !== fe.stripeChargesEnabled ||
          summary.payoutsEnabled !== fe.stripePayoutsEnabled ||
          summary.detailsSubmitted !== fe.stripeDetailsSubmitted;
        if (changed) {
          await tx
            .update(franchisees)
            .set({
              stripeChargesEnabled: summary.chargesEnabled,
              stripePayoutsEnabled: summary.payoutsEnabled,
              stripeDetailsSubmitted: summary.detailsSubmitted,
              updatedAt: new Date(),
            })
            .where(eq(franchisees.id, fe.id));
        }
        return {
          kind: 'ok' as const,
          accountId: summary.id,
          chargesEnabled: summary.chargesEnabled,
          payoutsEnabled: summary.payoutsEnabled,
          detailsSubmitted: summary.detailsSubmitted,
        };
      });
      if (result.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
        });
      }
      if (result.kind === 'forbidden') {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Connect status is admin-only' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: {
          accountId: result.accountId,
          chargesEnabled: result.chargesEnabled,
          payoutsEnabled: result.payoutsEnabled,
          detailsSubmitted: result.detailsSubmitted,
        },
      });
    },
  );
}
