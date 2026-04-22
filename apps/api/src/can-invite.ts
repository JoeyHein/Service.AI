/**
 * Role-matrix authorization for the invitation flow (TASK-TEN-05).
 *
 * Pure function — no DB, no side effects. Given the inviter's effective
 * RequestScope and the target role + scope context they want to invite
 * into, returns whether the action is permitted.
 *
 * Privilege matrix (rows are inviters, columns are invitable roles):
 *
 *                       pf_admin fr_admin fe_owner loc_mgr disp tech csr
 *   platform_admin          ✓        ✓        ✓        ✓      ✓    ✓    ✓
 *   franchisor_admin        ✗        ✓*       ✓†       ✓†     ✓†   ✓†   ✓†
 *   franchisee_owner        ✗        ✗        ✗        ✓‡     ✓‡   ✓‡   ✓‡
 *   location_manager        ✗        ✗        ✗        ✗      ✓‡   ✓‡   ✓‡
 *   dispatcher/tech/csr     ✗        ✗        ✗        ✗      ✗    ✗    ✗
 *
 *   * only within their own franchisor
 *   † only at a franchisee whose franchisor matches theirs (caller validates
 *     the targetFranchiseeId's parent franchisor separately — this function
 *     takes the checked franchisorId as input)
 *   ‡ only within their own franchisee
 *
 * Platform admin never shows up as an invitable role — the platform admin
 * role is assigned out-of-band (e.g., by the seed script or a DB
 * intervention), never via an invite.
 */
import type { RequestScope } from '@service-ai/db';

export type InvitableRole =
  | 'franchisor_admin'
  | 'franchisee_owner'
  | 'location_manager'
  | 'dispatcher'
  | 'tech'
  | 'csr';

/** Target scope the invite will land at. Matches scope_type without 'platform'. */
export type InviteScopeType = 'franchisor' | 'franchisee' | 'location';

export interface InviteTarget {
  role: InvitableRole;
  scopeType: InviteScopeType;
  /**
   * Resolved franchisor of the target scope. Caller resolves this from the
   * target franchiseeId/locationId before calling canInvite — keeps this
   * function DB-free and synchronous.
   */
  franchisorId: string;
  /** Present when scopeType is 'franchisee' or 'location'. */
  franchiseeId?: string;
  /** Present when scopeType is 'location'. */
  locationId?: string;
}

const FRANCHISEE_SCOPED_ROLES: ReadonlySet<InvitableRole> = new Set([
  'location_manager',
  'dispatcher',
  'tech',
  'csr',
]);

const LOCATION_MANAGER_INVITABLE: ReadonlySet<InvitableRole> = new Set([
  'dispatcher',
  'tech',
  'csr',
]);

export function canInvite(inviter: RequestScope, target: InviteTarget): boolean {
  // Platform admin: no restrictions (still cannot invite a platform admin,
  // but the InvitableRole union already excludes that case at the type level).
  if (inviter.type === 'platform') return true;

  // Franchisor admin: anywhere within their franchisor. Cannot escalate to
  // another franchisor, and cannot invite a platform_admin (not in the
  // InvitableRole union).
  if (inviter.type === 'franchisor') {
    if (target.franchisorId !== inviter.franchisorId) return false;
    return true;
  }

  // franchisee-scoped inviter: only within their own franchisee.
  if (target.franchisorId !== inviter.franchisorId) return false;
  if (target.franchiseeId !== inviter.franchiseeId) return false;

  // franchisee_owner can invite location_manager / dispatcher / tech / csr.
  if (inviter.role === 'franchisee_owner') {
    return FRANCHISEE_SCOPED_ROLES.has(target.role);
  }

  // location_manager can invite dispatcher / tech / csr.
  if (inviter.role === 'location_manager') {
    return LOCATION_MANAGER_INVITABLE.has(target.role);
  }

  // dispatcher, tech, csr: cannot invite.
  return false;
}
