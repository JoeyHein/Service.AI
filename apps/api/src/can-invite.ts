/**
 * Role-matrix authorization for the invitation flow under the corporate
 * hub model.
 *
 * Privilege matrix (rows are inviters, columns are invitable roles):
 *
 *                       co_admin manager  disp tech csr
 *   corporate_admin        x        ok      ok   ok   ok    (any branch)
 *   manager                x        x       ok†  ok†  ok†   (own branch only)
 *   dispatcher/tech/csr    x        x       x    x    x
 *
 *   † manager can only invite users into their own branch.
 *
 * Corporate admin is assigned out-of-band; it is not an invitable role.
 */
import type { RequestScope } from '@service-ai/db';

export type InvitableRole = 'manager' | 'dispatcher' | 'tech' | 'csr';

export type InviteScopeType = 'branch';

export interface InviteTarget {
  role: InvitableRole;
  scopeType: InviteScopeType;
  /** The branch the invite targets. */
  branchId: string;
  /** Optional location pin; ignored by canInvite. */
  locationId?: string;
}

const MANAGER_INVITABLE: ReadonlySet<InvitableRole> = new Set([
  'dispatcher',
  'tech',
  'csr',
]);

export function canInvite(inviter: RequestScope, target: InviteTarget): boolean {
  // Corporate admin: invite any role into any branch.
  if (inviter.type === 'corporate') return true;

  // Branch-scoped inviter: must target their own branch.
  if (target.branchId !== inviter.branchId) return false;

  // Manager can invite dispatcher / tech / csr into their branch.
  if (inviter.role === 'manager') {
    return MANAGER_INVITABLE.has(target.role);
  }

  // dispatcher, tech, csr: cannot invite.
  return false;
}
