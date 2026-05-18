/**
 * Matrix tests for the canInvite role-invitation authorization under the
 * corporate hub model (CHR-02).
 *
 * Corporate admin can invite any role into any branch; manager can invite
 * dispatcher/tech/csr into their own branch only; everyone else is denied.
 */
import { describe, it, expect } from 'vitest';
import { canInvite, type InvitableRole, type InviteTarget } from '../can-invite.js';
import type { RequestScope } from '@service-ai/db';

const BRANCH_A = 'a1111111-1111-1111-1111-111111111111';
const BRANCH_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const corporateAdmin: RequestScope = {
  type: 'corporate',
  userId: 'u-ca',
  role: 'corporate_admin',
};
const managerA: RequestScope = {
  type: 'branch',
  userId: 'u-ma',
  role: 'manager',
  branchId: BRANCH_A,
};
const dispatcherA: RequestScope = {
  type: 'branch',
  userId: 'u-da',
  role: 'dispatcher',
  branchId: BRANCH_A,
};
const techA: RequestScope = {
  type: 'branch',
  userId: 'u-ta',
  role: 'tech',
  branchId: BRANCH_A,
};
const csrA: RequestScope = {
  type: 'branch',
  userId: 'u-csa',
  role: 'csr',
  branchId: BRANCH_A,
};

function target(
  role: InvitableRole,
  branchId: string = BRANCH_A,
): InviteTarget {
  return {
    role,
    scopeType: 'branch',
    branchId,
  };
}

const ALL_INVITABLE: InvitableRole[] = [
  'manager',
  'dispatcher',
  'tech',
  'csr',
];

describe('canInvite — corporate_admin', () => {
  it.each(ALL_INVITABLE)('allows inviting %s into any branch', (role) => {
    expect(canInvite(corporateAdmin, target(role, BRANCH_A))).toBe(true);
    expect(canInvite(corporateAdmin, target(role, BRANCH_B))).toBe(true);
  });
});

describe('canInvite — manager', () => {
  it('allows dispatcher / tech / csr within own branch', () => {
    for (const role of ['dispatcher', 'tech', 'csr'] as const) {
      expect(canInvite(managerA, target(role, BRANCH_A))).toBe(true);
    }
  });

  it('forbids inviting another manager', () => {
    expect(canInvite(managerA, target('manager', BRANCH_A))).toBe(false);
  });

  it('forbids inviting into a different branch', () => {
    expect(canInvite(managerA, target('dispatcher', BRANCH_B))).toBe(false);
  });
});

describe('canInvite — non-management roles cannot invite', () => {
  it.each([dispatcherA, techA, csrA])('%s role: every target is forbidden', (inviter) => {
    for (const role of ALL_INVITABLE) {
      expect(canInvite(inviter, target(role, BRANCH_A))).toBe(false);
    }
  });
});
