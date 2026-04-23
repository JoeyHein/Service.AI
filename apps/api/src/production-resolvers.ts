/**
 * Production-grade implementations of the three request-scope injection
 * seams (MembershipResolver, FranchiseeLookup, AuditLogWriter).
 *
 * These run against the admin Drizzle handle — RLS-bypassed because they
 * are infrastructure reads/writes that operate on behalf of the
 * requestScopePlugin itself, not a tenant request handler. The plugin
 * then narrows the resolved scope and downstream queries opt into RLS via
 * withScope().
 *
 * Kept separate from apps/api/src/index.ts so tests can import these
 * constructors directly if they ever want to exercise the real resolvers
 * against a live DB rather than a mock.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@service-ai/db';
import { memberships, franchisees, auditLog } from '@service-ai/db';
import type {
  MembershipResolver,
  MembershipRow,
  FranchiseeLookup,
  AuditLogWriter,
  AuditLogEntry,
} from './request-scope.js';

type Drizzle = NodePgDatabase<typeof schema>;

export function membershipResolver(db: Drizzle): MembershipResolver {
  return {
    async memberships(userId: string): Promise<MembershipRow[]> {
      // franchisor_admin rows carry scope_type='franchisor' + scope_id =
      // franchisor uuid and have franchisee_id = NULL. For those rows the
      // LEFT JOIN on franchisees.id can't resolve franchisor_id, so we
      // COALESCE to the scope_id directly. For franchisee-scoped rows
      // the join provides it.
      const rows = await db
        .select({
          scopeType: memberships.scopeType,
          role: memberships.role,
          franchisorId: sql<string | null>`COALESCE(
            CASE WHEN ${memberships.scopeType} = 'franchisor'
                 THEN ${memberships.scopeId}::text
                 ELSE NULL END,
            ${franchisees.franchisorId}::text
          )`,
          franchiseeId: memberships.franchiseeId,
          locationId: memberships.locationId,
        })
        .from(memberships)
        .leftJoin(franchisees, eq(franchisees.id, memberships.franchiseeId))
        .where(and(eq(memberships.userId, userId), isNull(memberships.deletedAt)));
      // Cast DB enums to the narrower TS unions expected by MembershipRow.
      return rows as unknown as MembershipRow[];
    },
  };
}

export function franchiseeLookup(db: Drizzle): FranchiseeLookup {
  return {
    async franchisorIdFor(franchiseeId: string): Promise<string | null> {
      const rows = await db
        .select({ franchisorId: franchisees.franchisorId })
        .from(franchisees)
        .where(eq(franchisees.id, franchiseeId));
      return rows[0]?.franchisorId ?? null;
    },
  };
}

export function auditLogWriter(db: Drizzle): AuditLogWriter {
  return {
    async write(entry: AuditLogEntry): Promise<void> {
      await db.insert(auditLog).values({
        actorUserId: entry.actorUserId,
        targetFranchiseeId: entry.targetFranchiseeId,
        action: entry.action,
        scopeType: entry.scopeType,
        scopeId: entry.scopeId,
        metadata: entry.metadata,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
      });
    },
  };
}
