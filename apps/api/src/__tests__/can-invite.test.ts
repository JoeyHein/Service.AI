/**
 * Exhaustive matrix tests for TASK-TEN-05 role-invitation authorization.
 *
 * Covers every (inviter role, target role, same-tenant?) combination so a
 * privilege escalation regression would be caught immediately.
 */
import { describe, it, expect } from 'vitest';
import { canInvite, type InvitableRole, type InviteTarget } from '../can-invite.js';
import type { RequestScope } from '@service-ai/db';

const FRANCHISOR_A = '11111111-1111-1111-1111-111111111111';
const FRANCHISOR_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FRANCHISEE_A1 = 'a1111111-1111-1111-1111-111111111111';
const FRANCHISEE_A2 = 'a2222222-2222-2222-2222-222222222222';
const FRANCHISEE_B1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const platformAdmin: RequestScope = {
  type: 'platform',
  userId: 'u-pa',
  role: 'platform_admin',
};
const franchisorAdminA: RequestScope = {
  type: 'franchisor',
  userId: 'u-faa',
  role: 'franchisor_admin',
  franchisorId: FRANCHISOR_A,
};
const franchiseeOwnerA1: RequestScope = {
  type: 'franchisee',
  userId: 'u-foa1',
  role: 'franchisee_owner',
  franchisorId: FRANCHISOR_A,
  franchiseeId: FRANCHISEE_A1,
};
const locationManagerA1: RequestScope = {
  type: 'franchisee',
  userId: 'u-lma1',
  role: 'location_manager',
  franchisorId: FRANCHISOR_A,
  franchiseeId: FRANCHISEE_A1,
};
const dispatcherA1: RequestScope = {
  type: 'franchisee',
  userId: 'u-da1',
  role: 'dispatcher',
  franchisorId: FRANCHISOR_A,
  franchiseeId: FRANCHISEE_A1,
};
const techA1: RequestScope = {
  type: 'franchisee',
  userId: 'u-ta1',
  role: 'tech',
  franchisorId: FRANCHISOR_A,
  franchiseeId: FRANCHISEE_A1,
};
const csrA1: RequestScope = {
  type: 'franchisee',
  userId: 'u-ca1',
  role: 'csr',
  franchisorId: FRANCHISOR_A,
  franchiseeId: FRANCHISEE_A1,
};

function target(
  role: InvitableRole,
  franchisorId = FRANCHISOR_A,
  franchiseeId: string | undefined = FRANCHISEE_A1,
): InviteTarget {
  const t: InviteTarget = {
    role,
    scopeType: role === 'franchisor_admin' ? 'franchisor' : 'franchisee',
    franchisorId,
  };
  if (franchiseeId) t.franchiseeId = franchiseeId;
  return t;
}

const ALL_INVITABLE: InvitableRole[] = [
  'franchisor_admin',
  'franchisee_owner',
  'location_manager',
  'dispatcher',
  'tech',
  'csr',
];

describe('canInvite — platform_admin', () => {
  it.each(ALL_INVITABLE)('allows inviting %s anywhere', (role) => {
    expect(canInvite(platformAdmin, target(role))).toBe(true);
    expect(canInvite(platformAdmin, target(role, FRANCHISOR_B, FRANCHISEE_B1))).toBe(true);
  });
});

describe('canInvite — franchisor_admin', () => {
  it.each(ALL_INVITABLE)('allows %s within their own franchisor', (role) => {
    const inviteTarget = target(
      role,
      FRANCHISOR_A,
      role === 'franchisor_admin' ? undefined : FRANCHISEE_A1,
    );
    expect(canInvite(franchisorAdminA, inviteTarget)).toBe(true);
  });

  it.each(ALL_INVITABLE)('forbids %s at another franchisor', (role) => {
    const inviteTarget = target(
      role,
      FRANCHISOR_B,
      role === 'franchisor_admin' ? undefined : FRANCHISEE_B1,
    );
    expect(canInvite(franchisorAdminA, inviteTarget)).toBe(false);
  });
});

describe('canInvite — franchisee_owner', () => {
  it('allows location_manager / dispatcher / tech / csr within own franchisee', () => {
    for (const role of ['location_manager', 'dispatcher', 'tech', 'csr'] as const) {
      expect(canInvite(franchiseeOwnerA1, target(role))).toBe(true);
    }
  });

  it('forbids franchisor_admin and franchisee_owner', () => {
    expect(canInvite(franchiseeOwnerA1, target('franchisor_admin', FRANCHISOR_A, undefined))).toBe(
      false,
    );
    expect(canInvite(franchiseeOwnerA1, target('franchisee_owner'))).toBe(false);
  });

  it('forbids even valid roles at a different franchisee', () => {
    expect(canInvite(franchiseeOwnerA1, target('dispatcher', FRANCHISOR_A, FRANCHISEE_A2))).toBe(
      false,
    );
  });

  it('forbids any role across franchisors', () => {
    expect(canInvite(franchiseeOwnerA1, target('tech', FRANCHISOR_B, FRANCHISEE_B1))).toBe(false);
  });
});

describe('canInvite — location_manager', () => {
  it('allows dispatcher / tech / csr within own franchisee', () => {
    for (const role of ['dispatcher', 'tech', 'csr'] as const) {
      expect(canInvite(locationManagerA1, target(role))).toBe(true);
    }
  });

  it('forbids location_manager, franchisee_owner, franchisor_admin', () => {
    expect(canInvite(locationManagerA1, target('location_manager'))).toBe(false);
    expect(canInvite(locationManagerA1, target('franchisee_owner'))).toBe(false);
    expect(
      canInvite(locationManagerA1, target('franchisor_admin', FRANCHISOR_A, undefined)),
    ).toBe(false);
  });

  it('forbids cross-franchisee / cross-franchisor', () => {
    expect(canInvite(locationManagerA1, target('dispatcher', FRANCHISOR_A, FRANCHISEE_A2))).toBe(
      false,
    );
    expect(canInvite(locationManagerA1, target('tech', FRANCHISOR_B, FRANCHISEE_B1))).toBe(false);
  });
});

describe('canInvite — non-management roles cannot invite', () => {
  it.each([dispatcherA1, techA1, csrA1])('%s role: every target is forbidden', (inviter) => {
    for (const role of ALL_INVITABLE) {
      expect(canInvite(inviter, target(role))).toBe(false);
    }
  });
});
