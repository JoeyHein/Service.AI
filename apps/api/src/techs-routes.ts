/**
 * List techs for dispatch (TASK-DB-01).
 *
 *   GET /api/v1/techs                    requires scope
 *                                        franchisee → own franchisee;
 *                                        platform/franchisor → need
 *                                        ?franchiseeId=<uuid>
 *
 * Returns { userId, name, email } for each active `tech` membership in
 * the target franchisee. Used by the dispatch board to render one
 * column per tech.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { franchisees, memberships, users, withScope, type RequestScope } from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

async function resolveFranchisee(
  db: Drizzle,
  scope: RequestScope,
  queryFranchiseeId: string | null,
): Promise<
  | { ok: true; franchiseeId: string }
  | { ok: false; status: number; code: string; message: string }
> {
  if (scope.type === 'franchisee') {
    if (queryFranchiseeId && queryFranchiseeId !== scope.franchiseeId) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Franchisee not in scope' };
    }
    return { ok: true, franchiseeId: scope.franchiseeId };
  }
  if (!queryFranchiseeId) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'franchiseeId query param is required for admin callers',
    };
  }
  const rows = await db
    .select({ franchisorId: franchisees.franchisorId })
    .from(franchisees)
    .where(eq(franchisees.id, queryFranchiseeId));
  if (rows.length === 0) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Franchisee not found' };
  }
  if (scope.type === 'franchisor' && rows[0]!.franchisorId !== scope.franchisorId) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Franchisee not in scope' };
  }
  return { ok: true, franchiseeId: queryFranchiseeId };
}

export function registerTechRoutes(app: FastifyInstance, db: Drizzle): void {
  app.get('/api/v1/techs', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    const q = req.query as Record<string, string | undefined>;
    const target = await resolveFranchisee(db, scope, q['franchiseeId']?.trim() || null);
    if (!target.ok) {
      return reply.code(target.status).send({
        ok: false,
        error: { code: target.code, message: target.message },
      });
    }
    const rows = await withScope(db, scope, (tx) =>
      tx
        .select({
          userId: memberships.userId,
          name: users.name,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.franchiseeId, target.franchiseeId),
            eq(memberships.role, 'tech'),
            isNull(memberships.deletedAt),
          ),
        ),
    );
    return reply.code(200).send({ ok: true, data: rows });
  });
}
