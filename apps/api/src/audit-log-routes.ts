/**
 * GET /api/v1/audit-log — paginated, filterable view of audit_log rows.
 *
 * Access: platform_admin and franchisor_admin only. Every other scope
 * type gets 403 AUDIT_FORBIDDEN so we don't leak the route to
 * franchisee-level users (they have no legitimate use for the log).
 *
 * Filters (all optional, combinable): actorEmail, franchiseeId, action,
 * fromDate, toDate. Pagination via limit (default 50, max 200) + offset.
 * Results ordered by created_at DESC — newest first is what operators
 * want by default.
 *
 * Like the other tenant-scoped endpoints in this phase, we combine
 * Postgres RLS (via withScope) with an explicit app-layer WHERE clause
 * as defence in depth — RLS fires in production (non-superuser role)
 * and the app-layer filter guards the dev superuser path.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditLog, franchisees, users, withScope } from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface AuditLogRow {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  targetFranchiseeId: string | null;
  action: string;
  scopeType: string | null;
  scopeId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export function registerAuditLogRoutes(app: FastifyInstance, db: Drizzle): void {
  app.get('/api/v1/audit-log', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (scope.type !== 'platform' && scope.type !== 'franchisor') {
      return reply.code(403).send({
        ok: false,
        error: {
          code: 'AUDIT_FORBIDDEN',
          message: 'Only platform or franchisor admins may read the audit log',
        },
      });
    }

    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(
      Math.max(parseInt(q['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);
    const actorEmail = q['actorEmail']?.trim() || null;
    const franchiseeId = q['franchiseeId']?.trim() || null;
    const action = q['action']?.trim() || null;
    const fromDate = q['fromDate'] ? new Date(q['fromDate']) : null;
    const toDate = q['toDate'] ? new Date(q['toDate']) : null;

    const { rows, total } = await withScope(db, scope, async (tx) => {
      const conditions = [] as unknown[];

      if (scope.type === 'franchisor') {
        // target_franchisee_id is in the acting franchisor's tree, or the
        // row is a cross-franchisee impersonation audit scoped directly
        // to the franchisor (scope_id = franchisorId, franchisee null).
        conditions.push(
          or(
            inArray(
              auditLog.targetFranchiseeId,
              tx
                .select({ id: franchisees.id })
                .from(franchisees)
                .where(eq(franchisees.franchisorId, scope.franchisorId)),
            ),
            and(
              isNull(auditLog.targetFranchiseeId),
              eq(auditLog.scopeType, 'franchisor'),
              eq(auditLog.scopeId, scope.franchisorId),
            ),
          ),
        );
      }
      if (franchiseeId) {
        conditions.push(eq(auditLog.targetFranchiseeId, franchiseeId));
      }
      if (action) {
        conditions.push(ilike(auditLog.action, `%${action}%`));
      }
      if (fromDate && !Number.isNaN(fromDate.getTime())) {
        conditions.push(gte(auditLog.createdAt, fromDate));
      }
      if (toDate && !Number.isNaN(toDate.getTime())) {
        conditions.push(lte(auditLog.createdAt, toDate));
      }
      if (actorEmail) {
        conditions.push(ilike(users.email, `%${actorEmail}%`));
      }

      const whereExpr =
        conditions.length === 0
          ? undefined
          : (and(...(conditions as Parameters<typeof and>)) as ReturnType<
              typeof and
            >);

      const base = tx
        .select({
          id: auditLog.id,
          actorUserId: auditLog.actorUserId,
          actorEmail: users.email,
          targetFranchiseeId: auditLog.targetFranchiseeId,
          action: auditLog.action,
          scopeType: auditLog.scopeType,
          scopeId: auditLog.scopeId,
          metadata: auditLog.metadata,
          ipAddress: auditLog.ipAddress,
          userAgent: auditLog.userAgent,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId));

      const query = whereExpr ? base.where(whereExpr) : base;
      const rows = await query
        .orderBy(desc(auditLog.createdAt))
        .limit(limit)
        .offset(offset);

      // Count total matching rows so the UI can render page indicators.
      const countBase = tx
        .select({ c: sql<number>`count(*)::int` })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId));
      const countQuery = whereExpr ? countBase.where(whereExpr) : countBase;
      const countRows = await countQuery;
      const total = countRows[0]?.c ?? 0;

      return { rows: rows as unknown as AuditLogRow[], total };
    });

    return reply.code(200).send({
      ok: true,
      data: { rows, total, limit, offset },
    });
  });
}
