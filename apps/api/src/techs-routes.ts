/**
 * List techs for dispatch (TASK-DB-01).
 *
 *   GET /api/v1/techs                    requires scope
 *                                        branch → own branch;
 *                                        platform/corporate → need
 *                                        ?branchId=<uuid>
 *
 * Returns { userId, name, email } for each active `tech` membership in
 * the target branch. Used by the dispatch board to render one
 * column per tech.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { branches, memberships, users, withScope, type RequestScope } from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

async function resolveBranch(
  db: Drizzle,
  scope: RequestScope,
  queryBranchId: string | null,
): Promise<
  | { ok: true; branchId: string }
  | { ok: false; status: number; code: string; message: string }
> {
  if (scope.type === 'branch') {
    if (queryBranchId && queryBranchId !== scope.branchId) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Branch not in scope' };
    }
    return { ok: true, branchId: scope.branchId };
  }
  if (!queryBranchId) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'branchId query param is required for corporate callers',
    };
  }
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.id, queryBranchId));
  if (rows.length === 0) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Branch not found' };
  }
  return { ok: true, branchId: queryBranchId };
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
    const target = await resolveBranch(db, scope, q['branchId']?.trim() || null);
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
            eq(memberships.branchId, target.branchId),
            eq(memberships.role, 'tech'),
            isNull(memberships.deletedAt),
          ),
        ),
    );
    return reply.code(200).send({ ok: true, data: rows });
  });
}
