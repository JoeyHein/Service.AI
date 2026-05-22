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
    /**
     * TD-SQB-FU3: per-tool overrides. The loop looks up
     * `perTool[toolName]?.confidenceThreshold` before falling back to the
     * global `confidenceThreshold`, so a high-stakes tool can demand more
     * confidence without every gated tool inheriting it. Mirrors the
     * CLAUDE.md "AI guardrail defaults" table.
     */
    perTool?: Record<
      string,
      { confidenceThreshold?: number; dollarCapCents?: number; undoWindowMin?: number }
    >;
  };
}

const DEFAULT_GUARDRAILS = {
  confidenceThreshold: 0.8,
  undoWindowSeconds: 900,
  transferOnLowConfidence: true,
  perTool: {
    // names are the registered tool names (see apps/api/src/ai-tools)
    bookJob: { confidenceThreshold: 0.8, undoWindowMin: 15 },
    quoteConfigurator: { confidenceThreshold: 0.7 },
    commitQuote: { confidenceThreshold: 0.9, dollarCapCents: 500_000, undoWindowMin: 5 },
    autoAssign: { confidenceThreshold: 0.8, undoWindowMin: 5 },
    photoQuote: { confidenceThreshold: 0.75, dollarCapCents: 50_000 },
    sendDraft: { confidenceThreshold: 0.9, undoWindowMin: 30 },
  } as Record<string, { confidenceThreshold?: number; dollarCapCents?: number; undoWindowMin?: number }>,
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
