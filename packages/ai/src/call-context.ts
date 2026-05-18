/**
 * Resolves which branch owns an incoming Twilio call. The
 * inbound `To` number is looked up against
 * `branches.twilio_phone_number`; an unknown number returns
 * null so the webhook route can hand up politely.
 */

import { eq } from 'drizzle-orm';
import { branches } from '@service-ai/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

export interface ResolvedCallTenant {
  branchId: string;
  branchName: string;
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
    .from(branches)
    .where(eq(branches.twilioPhoneNumber, toE164));
  const b = rows[0];
  if (!b) return null;
  // ai_guardrails moved out of branches in the corporate model; defaults
  // are applied here until per-branch guardrails are reintroduced.
  return {
    branchId: b.id,
    branchName: b.name,
    guardrails: { ...DEFAULT_GUARDRAILS },
  };
}
