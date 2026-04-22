/**
 * Invitation flow endpoints (TASK-TEN-05).
 *
 *   POST   /api/v1/invites              create invite (scoped; validated
 *                                       against canInvite role matrix)
 *   GET    /api/v1/invites              list pending invites the caller
 *                                       can see (RLS does the scoping)
 *   DELETE /api/v1/invites/:id          revoke — idempotent, second call
 *                                       returns { alreadyRevoked: true }
 *   GET    /api/v1/invites/accept/:tok  public metadata for the accept UI
 *                                       (no session; security = token hash)
 *   POST   /api/v1/invites/accept/:tok  redeem — requires session, the
 *                                       authenticated email must match
 *                                       the invite's email; creates the
 *                                       membership and marks the invite
 *                                       redeemed.
 *
 * The first three routes run under withScope() so Postgres RLS filters
 * rows to the caller's tenant slice. The accept routes bypass RLS
 * deliberately — their security guarantee is the 32-byte token's
 * unpredictability plus the 72h expiry and the email-match check on POST.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, gt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  invitations,
  memberships,
  users,
  franchisees,
  withScope,
  generateInviteToken,
  hashInviteToken,
  INVITE_TOKEN_TTL_MS,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { MagicLinkSender } from '@service-ai/auth';
import { canInvite, type InviteTarget } from './can-invite.js';

type Drizzle = NodePgDatabase<typeof schema>;

export interface InviteRoutesOptions {
  drizzle: Drizzle;
  magicLinkSender: MagicLinkSender;
  /** Origin used to construct accept URLs embedded in invite emails. */
  acceptUrlBase: string;
}

const CreateInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum([
    'franchisor_admin',
    'franchisee_owner',
    'location_manager',
    'dispatcher',
    'tech',
    'csr',
  ]),
  scopeType: z.enum(['franchisor', 'franchisee', 'location']),
  franchiseeId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
});

type CreateInviteBody = z.infer<typeof CreateInviteSchema>;

function errorEnvelope(code: string, message: string, statusCode: number) {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

/**
 * Build the InviteTarget the role matrix checks. Resolves the target's
 * franchisor via DB lookup when a franchiseeId is supplied so cross-tenant
 * attempts are rejected by canInvite rather than silently accepted.
 */
async function resolveTarget(
  db: Drizzle,
  body: CreateInviteBody,
  inviter: RequestScope,
): Promise<{ target: InviteTarget } | { error: ReturnType<typeof errorEnvelope> }> {
  if (body.scopeType === 'franchisor') {
    const franchisorId =
      inviter.type === 'franchisor'
        ? inviter.franchisorId
        : inviter.type === 'platform'
          ? body.franchiseeId // allow caller to specify; validated below
          : inviter.type === 'franchisee'
            ? inviter.franchisorId
            : undefined;
    if (!franchisorId) {
      return {
        error: errorEnvelope(
          'INVALID_TARGET',
          'franchisor-scoped invite requires caller with a franchisor',
          400,
        ),
      };
    }
    const target: InviteTarget = {
      role: body.role,
      scopeType: 'franchisor',
      franchisorId,
    };
    return { target };
  }

  if (!body.franchiseeId) {
    return {
      error: errorEnvelope(
        'INVALID_TARGET',
        'franchiseeId is required for franchisee/location-scoped invites',
        400,
      ),
    };
  }
  const rows = await db
    .select({ franchisorId: franchisees.franchisorId })
    .from(franchisees)
    .where(eq(franchisees.id, body.franchiseeId));
  const parent = rows[0];
  if (!parent) {
    return {
      error: errorEnvelope(
        'INVALID_TARGET',
        'Target franchisee does not exist',
        400,
      ),
    };
  }
  const target: InviteTarget = {
    role: body.role,
    scopeType: body.scopeType,
    franchisorId: parent.franchisorId,
    franchiseeId: body.franchiseeId,
  };
  if (body.locationId) target.locationId = body.locationId;
  return { target };
}

async function getInviterEmail(
  db: Drizzle,
  userId: string,
): Promise<string | null> {
  const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return rows[0]?.email ?? null;
}

export function registerInviteRoutes(
  app: FastifyInstance,
  opts: InviteRoutesOptions,
): void {
  const { drizzle: db, magicLinkSender, acceptUrlBase } = opts;

  // -------------------------------------------------------------------------
  // POST /api/v1/invites — create
  // -------------------------------------------------------------------------
  app.post('/api/v1/invites', async (req, reply) => {
    if (req.userId === null) {
      return reply
        .code(401)
        .send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (req.scope === null) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'NO_ACTIVE_MEMBERSHIP', message: 'Inviter has no active scope' },
      });
    }

    const parsed = CreateInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.message,
        },
      });
    }

    const resolved = await resolveTarget(db, parsed.data, req.scope);
    if ('error' in resolved) {
      return reply.code(resolved.error.statusCode).send(resolved.error.body);
    }
    const { target } = resolved;

    if (!canInvite(req.scope, target)) {
      return reply.code(403).send({
        ok: false,
        error: {
          code: 'ROLE_NOT_INVITABLE',
          message: 'Caller cannot invite this role at this scope',
        },
      });
    }

    const { token, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);

    const inserted = await db
      .insert(invitations)
      .values({
        tokenHash: hash,
        email: parsed.data.email.toLowerCase(),
        role: target.role,
        scopeType: target.scopeType,
        franchisorId: target.franchisorId,
        franchiseeId: target.franchiseeId ?? null,
        locationId: target.locationId ?? null,
        inviterUserId: req.userId,
        expiresAt,
      })
      .returning({ id: invitations.id, expiresAt: invitations.expiresAt });

    const row = inserted[0]!;
    const acceptUrl = `${acceptUrlBase.replace(/\/$/, '')}/accept-invite/${token}`;
    await magicLinkSender.send({
      email: parsed.data.email,
      url: acceptUrl,
      purpose: 'invite',
    });

    return reply.code(201).send({
      ok: true,
      data: { id: row.id, expiresAt: row.expiresAt, acceptUrl },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/invites — list pending (scoped via withScope + RLS)
  // -------------------------------------------------------------------------
  app.get('/api/v1/invites', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const rows = await withScope(db, req.scope, (tx) =>
      tx
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          scopeType: invitations.scopeType,
          franchiseeId: invitations.franchiseeId,
          expiresAt: invitations.expiresAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(
          and(
            isNull(invitations.redeemedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        ),
    );
    return reply.code(200).send({ ok: true, data: rows });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/invites/:id — idempotent revoke
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/api/v1/invites/:id', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }

    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
      });
    }

    const result = await withScope(db, req.scope, async (tx) => {
      const existing = await tx
        .select({ id: invitations.id, revokedAt: invitations.revokedAt })
        .from(invitations)
        .where(eq(invitations.id, id));
      const row = existing[0];
      if (!row) return { found: false as const };
      if (row.revokedAt !== null) return { found: true as const, alreadyRevoked: true };
      await tx
        .update(invitations)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(invitations.id, id));
      return { found: true as const, alreadyRevoked: false };
    });

    if (!result.found) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Invite not found or not in scope' },
      });
    }
    return reply
      .code(200)
      .send({ ok: true, data: { revoked: !result.alreadyRevoked, alreadyRevoked: result.alreadyRevoked } });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/invites/accept/:token — public metadata for the accept UI
  // RLS-bypass: security lives in the 32-byte token hash lookup + expiry.
  // -------------------------------------------------------------------------
  app.get<{ Params: { token: string } }>(
    '/api/v1/invites/accept/:token',
    async (req, reply) => {
      const hash = hashInviteToken(req.params.token);
      const rows = await db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          scopeType: invitations.scopeType,
          expiresAt: invitations.expiresAt,
          redeemedAt: invitations.redeemedAt,
          revokedAt: invitations.revokedAt,
        })
        .from(invitations)
        .where(eq(invitations.tokenHash, hash));
      const row = rows[0];
      if (!row) {
        return reply
          .code(404)
          .send({ ok: false, error: { code: 'NOT_FOUND', message: 'Invite not found' } });
      }
      if (row.revokedAt !== null) {
        return reply.code(410).send({
          ok: false,
          error: { code: 'INVITE_REVOKED', message: 'Invite was revoked' },
        });
      }
      if (row.redeemedAt !== null) {
        return reply.code(410).send({
          ok: false,
          error: { code: 'INVITE_USED', message: 'Invite was already redeemed' },
        });
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        return reply.code(410).send({
          ok: false,
          error: { code: 'INVITE_EXPIRED', message: 'Invite has expired' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: {
          email: row.email,
          role: row.role,
          scopeType: row.scopeType,
          expiresAt: row.expiresAt,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/invites/accept/:token — redeem and create membership
  // -------------------------------------------------------------------------
  app.post<{ Params: { token: string } }>(
    '/api/v1/invites/accept/:token',
    async (req, reply) => {
      if (req.userId === null) {
        return reply.code(401).send({
          ok: false,
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Sign-in required before accepting an invite',
          },
        });
      }

      const authedEmail = await getInviterEmail(db, req.userId);
      if (!authedEmail) {
        return reply.code(401).send({
          ok: false,
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Current session does not map to a known user',
          },
        });
      }

      const hash = hashInviteToken(req.params.token);
      const rows = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, hash));
      const row = rows[0];
      if (!row) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Invite not found' },
        });
      }
      if (row.revokedAt !== null) {
        return reply.code(410).send({
          ok: false,
          error: { code: 'INVITE_REVOKED', message: 'Invite was revoked' },
        });
      }
      if (row.redeemedAt !== null) {
        return reply.code(410).send({
          ok: false,
          error: { code: 'INVITE_USED', message: 'Invite was already redeemed' },
        });
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        return reply.code(410).send({
          ok: false,
          error: { code: 'INVITE_EXPIRED', message: 'Invite has expired' },
        });
      }
      if (row.email.toLowerCase() !== authedEmail.toLowerCase()) {
        return reply.code(403).send({
          ok: false,
          error: {
            code: 'EMAIL_MISMATCH',
            message: 'Authenticated email does not match the invite email',
          },
        });
      }

      const scopeId =
        row.scopeType === 'franchisor'
          ? row.franchisorId
          : row.scopeType === 'location'
            ? row.locationId
            : row.franchiseeId;

      const membership = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(memberships)
          .values({
            userId: req.userId as string,
            scopeType: row.scopeType,
            scopeId: scopeId ?? null,
            role: row.role,
            franchiseeId: row.franchiseeId,
            locationId: row.locationId,
          })
          .returning({ id: memberships.id });
        await tx
          .update(invitations)
          .set({
            redeemedAt: new Date(),
            redeemedUserId: req.userId,
            updatedAt: new Date(),
          })
          .where(eq(invitations.id, row.id));
        return inserted[0]!;
      });

      return reply.code(200).send({
        ok: true,
        data: {
          membershipId: membership.id,
          role: row.role,
          scopeType: row.scopeType,
          franchiseeId: row.franchiseeId,
        },
      });
    },
  );
}

