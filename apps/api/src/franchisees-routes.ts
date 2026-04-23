/**
 * GET /api/v1/franchisees — list franchisees visible to the caller.
 *
 * RLS + an explicit app-layer scope filter work together: the request
 * runs inside withScope() so Postgres RLS policies apply (production
 * non-superuser role), and the WHERE clause redundantly filters on
 * franchisor_id so the dev superuser connection behaves identically.
 * Matches the defence-in-depth pattern already established by the
 * invite endpoints in TEN-10.
 *
 * Returns a lean shape — id, name, slug — suitable for rendering the
 * "View as" picker on /franchisor/franchisees.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { franchisees, withScope } from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

export function registerFranchiseeRoutes(app: FastifyInstance, db: Drizzle): void {
  app.get('/api/v1/franchisees', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    const rows = await withScope(db, scope, (tx) => {
      const base = tx
        .select({
          id: franchisees.id,
          name: franchisees.name,
          slug: franchisees.slug,
          franchisorId: franchisees.franchisorId,
        })
        .from(franchisees);
      if (scope.type === 'platform') return base;
      if (scope.type === 'franchisor') {
        return base.where(eq(franchisees.franchisorId, scope.franchisorId));
      }
      return base.where(eq(franchisees.id, scope.franchiseeId));
    });
    return reply.code(200).send({ ok: true, data: rows });
  });
}
