/**
 * Resolves which franchisee owns an incoming Twilio call. The
 * inbound `To` number is looked up against
 * `franchisees.twilio_phone_number`; an unknown number returns
 * null so the webhook route can hand up politely.
 */

import { eq } from 'drizzle-orm';
import { franchisees } from '@service-ai/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

export interface ResolvedCallTenant {
  franchiseeId: string;
  franchisorId: string;
  franchiseeName: string;
  guardrails: {
    confidenceThreshold: number;
    undoWindowSeconds: number;
    transferOnLowConfidence: boolean;
  };
}

const DEFAULT_GUARDRAILS = {
  confidenceThreshold: 0.8,
  undoWindowSeconds: 900,
  transferOnLowConfidence: true,
};

export async function resolveTenantByToNumber(
  db: Drizzle,
  toE164: string,
): Promise<ResolvedCallTenant | null> {
  const rows = await db
    .select()
    .from(franchisees)
    .where(eq(franchisees.twilioPhoneNumber, toE164));
  const fe = rows[0];
  if (!fe) return null;
  const guardrails = parseGuardrails(fe.aiGuardrails);
  return {
    franchiseeId: fe.id,
    franchisorId: fe.franchisorId,
    franchiseeName: fe.name,
    guardrails,
  };
}

function parseGuardrails(raw: unknown): typeof DEFAULT_GUARDRAILS {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      confidenceThreshold:
        typeof obj.confidenceThreshold === 'number'
          ? obj.confidenceThreshold
          : DEFAULT_GUARDRAILS.confidenceThreshold,
      undoWindowSeconds:
        typeof obj.undoWindowSeconds === 'number'
          ? obj.undoWindowSeconds
          : DEFAULT_GUARDRAILS.undoWindowSeconds,
      transferOnLowConfidence:
        typeof obj.transferOnLowConfidence === 'boolean'
          ? obj.transferOnLowConfidence
          : DEFAULT_GUARDRAILS.transferOnLowConfidence,
    };
  }
  return DEFAULT_GUARDRAILS;
}
