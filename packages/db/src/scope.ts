/**
 * Request scope types and GUC-setting helper.
 *
 * `RequestScope` is the canonical description of "who is calling, and what
 * slice of the tenant tree they can act on". It is resolved by the API's
 * RequestScope Fastify plugin from session + memberships + optional
 * impersonation, then threaded through every scoped query via `withScope`.
 *
 * `withScope(scope, fn)` opens a transaction, sets three local GUCs that the
 * RLS policies (migration 0003) read, runs `fn(tx)` inside that transaction,
 * and commits or rolls back. The `is_local = true` flag on set_config means
 * the GUCs auto-clear at transaction end — one request cannot leak scope to
 * the next.
 */
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

type AppSchema = typeof schema;

/** The Drizzle transaction handle passed to `withScope`'s callback. */
export type ScopedTx = NodePgTransaction<AppSchema, ExtractTablesWithRelations<AppSchema>>;

/** Roles that can only see a single franchisee slice of the data. */
export type FranchiseeRole =
  | 'franchisee_owner'
  | 'location_manager'
  | 'dispatcher'
  | 'tech'
  | 'csr';

/**
 * Discriminated by `type` so that handlers can pattern-match on the scope
 * shape rather than guarding on undefined fields. Every variant carries the
 * authenticated `userId` for audit-log authorship.
 */
export type RequestScope =
  | { type: 'platform'; userId: string; role: 'platform_admin' }
  | {
      type: 'franchisor';
      userId: string;
      role: 'franchisor_admin';
      franchisorId: string;
    }
  | {
      type: 'franchisee';
      userId: string;
      role: FranchiseeRole;
      franchisorId: string;
      franchiseeId: string;
      locationId?: string | null;
    };

export interface ScopeGucs {
  role: string;
  franchisorId: string;
  franchiseeId: string;
  userId: string;
}

/**
 * Flatten a RequestScope into the three string values that the RLS policies
 * read via `current_setting('app.*', true)`. Unset values become empty
 * strings; the policy migration uses `nullif(..., '')::uuid` so empty strings
 * coerce back to NULL and fail the match safely.
 */
export function scopeToGucs(scope: RequestScope): ScopeGucs {
  switch (scope.type) {
    case 'platform':
      return {
        role: 'platform_admin',
        franchisorId: '',
        franchiseeId: '',
        userId: scope.userId,
      };
    case 'franchisor':
      return {
        role: 'franchisor_admin',
        franchisorId: scope.franchisorId,
        franchiseeId: '',
        userId: scope.userId,
      };
    case 'franchisee':
      return {
        role: scope.role,
        franchisorId: scope.franchisorId,
        franchiseeId: scope.franchiseeId,
        userId: scope.userId,
      };
  }
}

/**
 * Run `fn` inside a transaction with the RLS GUCs set to `scope`'s values.
 * The GUCs are transaction-local (is_local=true) and auto-clear at COMMIT or
 * ROLLBACK — safe against cross-request leakage even with connection pooling.
 *
 * Throws whatever `fn` throws; the transaction is rolled back by Drizzle.
 */
export async function withScope<T>(
  db: NodePgDatabase<AppSchema>,
  scope: RequestScope,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  const gucs = scopeToGucs(scope);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.role', ${gucs.role}, true)`);
    await tx.execute(
      sql`select set_config('app.franchisor_id', ${gucs.franchisorId}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.franchisee_id', ${gucs.franchiseeId}, true)`,
    );
    await tx.execute(sql`select set_config('app.user_id', ${gucs.userId}, true)`);
    return fn(tx);
  });
}
