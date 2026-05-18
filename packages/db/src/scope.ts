/**
 * Request scope types and GUC-setting helper.
 *
 * `RequestScope` is the canonical description of "who is calling, and what
 * slice of the tenant tree they can act on" under the corporate hub model
 * (CHR phase). It is resolved by the API's RequestScope Fastify plugin from
 * session + memberships, then threaded through every scoped query via
 * `withScope`.
 *
 * `withScope(scope, fn)` opens a transaction, sets two local GUCs that the
 * RLS policies (migration 0016) read, runs `fn(tx)` inside that transaction,
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

/** Roles that can only see a single branch slice of the data. */
export type BranchRole = 'manager' | 'dispatcher' | 'tech' | 'csr';

/** Every role recognised by the corporate hub model. */
export type Role = 'corporate_admin' | BranchRole;

/**
 * Discriminated by `type` so that handlers can pattern-match on the scope
 * shape rather than guarding on undefined fields. Every variant carries the
 * authenticated `userId` for audit-log authorship.
 *
 * The `corporate` variant has no branch restriction — corporate_admin sees
 * every branch. The `branch` variant pins the caller to a single branch
 * and is enforced by RLS at the DB layer via `app.branch_id`.
 */
export type RequestScope =
  | { type: 'corporate'; userId: string; role: 'corporate_admin' }
  | {
      type: 'branch';
      userId: string;
      role: BranchRole;
      branchId: string;
    };

export interface ScopeGucs {
  role: string;
  branchId: string;
  userId: string;
}

/**
 * Flatten a RequestScope into the string values that the RLS policies read
 * via `current_setting('app.*', true)`. The corporate variant sets branchId
 * to an empty string; the policy migration uses `nullif(..., '')::uuid` so
 * empty strings coerce back to NULL and fail the scoped match safely (only
 * the `_corporate_admin` policy will permit the read).
 */
export function scopeToGucs(scope: RequestScope): ScopeGucs {
  switch (scope.type) {
    case 'corporate':
      return {
        role: 'corporate_admin',
        branchId: '',
        userId: scope.userId,
      };
    case 'branch':
      return {
        role: scope.role,
        branchId: scope.branchId,
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
      sql`select set_config('app.branch_id', ${gucs.branchId}, true)`,
    );
    await tx.execute(sql`select set_config('app.user_id', ${gucs.userId}, true)`);
    return fn(tx);
  });
}

/**
 * Backwards-compat alias retained for the CHR-02 transition. Existing call
 * sites under apps/api still import `FranchiseeRole` from this package;
 * CHR-03 removes the alias once every consumer has been swept.
 * @deprecated use BranchRole. Removed in CHR-03.
 */
export type FranchiseeRole = BranchRole;
