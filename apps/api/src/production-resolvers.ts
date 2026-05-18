/**
 * Production-grade implementations of the two request-scope injection
 * seams (MembershipResolver, AuditLogWriter).
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
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@service-ai/db';
import { memberships, auditLog } from '@service-ai/db';
import type {
  MembershipResolver,
  MembershipRow,
  AuditLogWriter,
  AuditLogEntry,
} from './request-scope.js';

type Drizzle = NodePgDatabase<typeof schema>;

/**
 * Tolerate the legacy `scope_type` enum values that Postgres cannot drop
 * (`platform`, `location`). Any row that still has one is promoted to its
 * corporate-hub equivalent. The application never WRITES these legacy
 * values — only reads them defensively for partially-migrated fixtures.
 */
function readScopeType(value: string): 'corporate' | 'branch' {
  if (value === 'platform' || value === 'corporate') return 'corporate';
  return 'branch';
}

export function membershipResolver(db: Drizzle): MembershipResolver {
  return {
    async memberships(userId: string): Promise<MembershipRow[]> {
      const rows = await db
        .select({
          scopeType: memberships.scopeType,
          role: memberships.role,
          branchId: memberships.branchId,
        })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), isNull(memberships.deletedAt)));
      return rows.map((r) => ({
        scopeType: readScopeType(r.scopeType as unknown as string),
        role: r.role as MembershipRow['role'],
        branchId: r.branchId,
      }));
    },
  };
}

export function auditLogWriter(db: Drizzle): AuditLogWriter {
  return {
    async write(entry: AuditLogEntry): Promise<void> {
      await db.insert(auditLog).values({
        actorUserId: entry.actorUserId,
        targetBranchId: entry.targetBranchId,
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
