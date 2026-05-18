/**
 * Twilio phone provisioning endpoints.
 *
 *   POST /api/v1/franchisees/:id/phone/provision
 *     Provisions a Twilio number via the TelephonyClient adapter and
 *     stamps branches.twilio_phone_number. Idempotent — returns the
 *     existing number without re-provisioning when already set.
 *
 *   GET  /api/v1/franchisees/:id/phone
 *     Returns the current provisioned number (or null).
 *
 *   PATCH /api/v1/franchisees/:id/ai-guardrails
 *     410 GONE — per-branch ai_guardrails was removed in the corporate
 *     hub redesign. Defaults apply globally until per-branch guardrails
 *     are reintroduced.
 *
 * Admin-only: corporate_admin only.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  branches,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PhoneProvisionOutput {
  phoneNumberE164: string;
  twilioSid: string;
}

export interface PhoneProvisioner {
  provision(input: {
    branchId: string;
    areaCode?: string;
    friendlyName?: string;
  }): Promise<PhoneProvisionOutput>;
}

const ProvisionBody = z.object({
  areaCode: z.string().regex(/^\d{3}$/).optional(),
  friendlyName: z.string().max(200).optional(),
});

function canAdminBranch(scope: RequestScope): boolean {
  return scope.type === 'corporate';
}

// TODO(CHR-06): rewrite route segment as /api/v1/corporate/branches/:id/phone.
export function registerPhoneRoutes(
  app: FastifyInstance,
  db: Drizzle,
  provisioner: PhoneProvisioner,
): void {
  app.post<{ Params: { id: string } }>( // TODO(CHR-06): rename route segment
    '/api/v1/franchisees/:id/phone/provision',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = ProvisionBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(branches)
          .where(eq(branches.id, req.params.id));
        const br = rows[0];
        if (!br) return { kind: 'not_found' as const };
        if (!canAdminBranch(scope)) return { kind: 'forbidden' as const };
        if (br.twilioPhoneNumber) {
          return {
            kind: 'already' as const,
            phoneNumberE164: br.twilioPhoneNumber,
          };
        }
        const result = await provisioner.provision({
          branchId: br.id,
          areaCode: parsed.data.areaCode,
          friendlyName: parsed.data.friendlyName ?? br.name,
        });
        await tx
          .update(branches)
          .set({
            twilioPhoneNumber: result.phoneNumberE164,
            updatedAt: new Date(),
          })
          .where(eq(branches.id, br.id));
        return {
          kind: 'ok' as const,
          phoneNumberE164: result.phoneNumberE164,
          twilioSid: result.twilioSid,
        };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Branch not found' },
        });
      }
      if (outcome.kind === 'forbidden') {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin-only' },
        });
      }
      if (outcome.kind === 'already') {
        return reply.code(200).send({
          ok: true,
          data: {
            phoneNumberE164: outcome.phoneNumberE164,
            alreadyProvisioned: true,
          },
        });
      }
      return reply.code(201).send({
        ok: true,
        data: {
          phoneNumberE164: outcome.phoneNumberE164,
          twilioSid: outcome.twilioSid,
          alreadyProvisioned: false,
        },
      });
    },
  );

  app.get<{ Params: { id: string } }>( // TODO(CHR-06): rename route segment
    '/api/v1/franchisees/:id/phone',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(branches)
          .where(eq(branches.id, req.params.id));
        const br = rows[0];
        if (!br) return { kind: 'not_found' as const };
        if (!canAdminBranch(scope)) return { kind: 'forbidden' as const };
        return {
          kind: 'ok' as const,
          phoneNumberE164: br.twilioPhoneNumber,
        };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Branch not found' },
        });
      }
      if (outcome.kind === 'forbidden') {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin-only' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { phoneNumberE164: outcome.phoneNumberE164 },
      });
    },
  );

  app.patch('/api/v1/franchisees/:id/ai-guardrails', (_req, reply) => // TODO(CHR-06): rename route segment
    reply.code(410).send({
      ok: false,
      error: {
        code: 'GUARDRAILS_REMOVED',
        message:
          'Per-branch ai_guardrails was removed in the corporate hub redesign (migration 0016).',
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Default stub provisioner — deterministic +1555xxxxxxx per branchId so
// the value is stable across reboots.
// ---------------------------------------------------------------------------

export function stubPhoneProvisioner(): PhoneProvisioner {
  let counter = 0;
  function hashDigits(seed: string, n: number): string {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) & 0x7fffffff;
    }
    return String(h).padStart(n, '0').slice(0, n);
  }
  return {
    async provision(input) {
      counter++;
      const tail = hashDigits(input.branchId + ':' + counter, 7);
      return {
        phoneNumberE164: `+1555${tail}`,
        twilioSid: `PNstub${tail}${counter}`,
      };
    },
  };
}
