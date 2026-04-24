/**
 * Twilio phone provisioning endpoints (TASK-CV-06).
 *
 *   POST /api/v1/franchisees/:id/phone/provision
 *     Provisions a Twilio number via the TelephonyClient adapter,
 *     stamps franchisees.twilio_phone_number. Idempotent — returns
 *     the existing number without re-provisioning when already set.
 *
 *   GET  /api/v1/franchisees/:id/phone
 *     Returns the current provisioned number (or null).
 *
 *   PATCH /api/v1/franchisees/:id/ai-guardrails
 *     Updates the per-franchisee guardrail config jsonb.
 *
 * All three are admin-only: platform_admin + owning franchisor_admin.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  franchisees,
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
    franchiseeId: string;
    areaCode?: string;
    friendlyName?: string;
  }): Promise<PhoneProvisionOutput>;
}

const GuardrailsSchema = z.object({
  confidenceThreshold: z.number().min(0).max(1).optional(),
  undoWindowSeconds: z.number().int().min(0).max(86400).optional(),
  transferOnLowConfidence: z.boolean().optional(),
});

const ProvisionBody = z.object({
  areaCode: z.string().regex(/^\d{3}$/).optional(),
  friendlyName: z.string().max(200).optional(),
});

function canAdminFranchisee(scope: RequestScope, franchisorId: string): boolean {
  if (scope.type === 'platform') return true;
  if (scope.type === 'franchisor' && scope.franchisorId === franchisorId)
    return true;
  return false;
}

export function registerPhoneRoutes(
  app: FastifyInstance,
  db: Drizzle,
  provisioner: PhoneProvisioner,
): void {
  // ----- POST /franchisees/:id/phone/provision -----------------------------
  app.post<{ Params: { id: string } }>(
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
          .from(franchisees)
          .where(eq(franchisees.id, req.params.id));
        const fe = rows[0];
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };
        if (fe.twilioPhoneNumber) {
          return {
            kind: 'already' as const,
            phoneNumberE164: fe.twilioPhoneNumber,
          };
        }
        const result = await provisioner.provision({
          franchiseeId: fe.id,
          areaCode: parsed.data.areaCode,
          friendlyName: parsed.data.friendlyName ?? fe.name,
        });
        await tx
          .update(franchisees)
          .set({
            twilioPhoneNumber: result.phoneNumberE164,
            updatedAt: new Date(),
          })
          .where(eq(franchisees.id, fe.id));
        return {
          kind: 'ok' as const,
          phoneNumberE164: result.phoneNumberE164,
          twilioSid: result.twilioSid,
        };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
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

  // ----- GET /franchisees/:id/phone -----------------------------------------
  app.get<{ Params: { id: string } }>(
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
          .from(franchisees)
          .where(eq(franchisees.id, req.params.id));
        const fe = rows[0];
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };
        return {
          kind: 'ok' as const,
          phoneNumberE164: fe.twilioPhoneNumber,
        };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
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

  // ----- PATCH /franchisees/:id/ai-guardrails -------------------------------
  app.patch<{ Params: { id: string } }>(
    '/api/v1/franchisees/:id/ai-guardrails',
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
      const parsed = GuardrailsSchema.safeParse(req.body ?? {});
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
          .from(franchisees)
          .where(eq(franchisees.id, req.params.id));
        const fe = rows[0];
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };
        const current = (fe.aiGuardrails ?? {}) as Record<string, unknown>;
        const merged = { ...current, ...parsed.data };
        await tx
          .update(franchisees)
          .set({ aiGuardrails: merged, updatedAt: new Date() })
          .where(eq(franchisees.id, fe.id));
        return { kind: 'ok' as const, guardrails: merged };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
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
        data: outcome.guardrails,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Default stub provisioner (used when no real TelephonyClient is
// wired — e.g. tests, local dev). Deterministic +1555xxxxxxx per
// franchiseeId so the value is stable across reboots.
// ---------------------------------------------------------------------------

export function stubPhoneProvisioner(): PhoneProvisioner {
  let counter = 0;
  function hashDigits(seed: string, n: number): string {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) & 0x7fffffff;
    }
    let out = '';
    for (let i = 0; i < n; i++) {
      out += String(h % 10);
      h = Math.floor(h / 10) || 3;
    }
    return out;
  }
  return {
    async provision({ franchiseeId, areaCode }) {
      counter += 1;
      const ac = areaCode ?? '555';
      return {
        phoneNumberE164: `+1${ac}${hashDigits(franchiseeId, 7)}`,
        twilioSid: `PNstub${counter}`,
      };
    },
  };
}
