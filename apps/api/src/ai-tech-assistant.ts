/**
 * Tech assistant pipelines (phase_ai_tech_assistant).
 *
 *   techPhotoQuote({ imageRef, description? }) →
 *       vision identify → RAG tag retrieval → pricebook SKU
 *       resolution → 3 candidate line items with
 *       requiresConfirmation flag for above-cap items.
 *
 *   techNotesToInvoice({ notes }) →
 *       single AIClient.turn with a text-only system prompt;
 *       returns { description, intent, warnings[] }.
 *
 * Both record to ai_conversations + ai_messages so the
 * capabilities are auditable alongside CSR/dispatcher turns.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  aiConversations,
  aiMessages,
  franchisees,
  franchiseAgreements,
  jobs,
  pricebookOverrides,
  serviceCatalogTemplates,
  serviceItems,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { AIClient } from '@service-ai/ai';
import { retrieveKnowledge, type RetrievedDoc } from './rag-retriever.js';
import type { EmbeddingClient } from './embedding.js';
import type { VisionClient, VisionIdentifyOutput } from './vision.js';

type Drizzle = NodePgDatabase<typeof schema>;

export interface TechAssistantDeps {
  db: Drizzle;
  ai: AIClient;
  vision: VisionClient;
  embedding?: EmbeddingClient;
}

// ---------------------------------------------------------------------------
// photoQuote
// ---------------------------------------------------------------------------

export interface PhotoQuoteInput {
  scope: RequestScope;
  franchiseeId: string;
  jobId: string;
  imageRef: string;
  /** Optional tech-supplied context ("customer says it snapped"). */
  description?: string;
}

export interface QuoteCandidate {
  serviceItemId: string;
  sku: string;
  name: string;
  /** Resolved effective price in dollars, already honouring any
   *  franchisee override. */
  unitPriceDollars: string;
  confidence: number;
  reasoning: string;
  /** When true, the API caller must record an explicit tech
   *  confirmation before adding to the invoice. */
  requiresConfirmation: boolean;
  /** KB docs that supported the suggestion — shown in the tech UI. */
  supportingSources: string[];
}

export interface PhotoQuoteResult {
  conversationId: string;
  vision: VisionIdentifyOutput;
  candidates: QuoteCandidate[];
}

const DEFAULT_CAP_CENTS = 50000;

function extractSkuTags(tags: string[]): string[] {
  return tags
    .filter((t) => t.startsWith('sku:'))
    .map((t) => t.slice(4).toUpperCase());
}

async function resolveEffectivePrice(
  tx: ScopedTx,
  franchiseeId: string,
  serviceItemId: string,
): Promise<{ basePrice: string; effective: string } | null> {
  const itemRows = await tx
    .select({
      id: serviceItems.id,
      basePrice: serviceItems.basePrice,
    })
    .from(serviceItems)
    .where(eq(serviceItems.id, serviceItemId));
  const item = itemRows[0];
  if (!item) return null;
  const overrideRows = await tx
    .select({ overridePrice: pricebookOverrides.overridePrice })
    .from(pricebookOverrides)
    .where(
      and(
        eq(pricebookOverrides.franchiseeId, franchiseeId),
        eq(pricebookOverrides.serviceItemId, serviceItemId),
      ),
    );
  const effective = overrideRows[0]?.overridePrice ?? item.basePrice;
  return { basePrice: item.basePrice, effective };
}

export async function techPhotoQuote(
  deps: TechAssistantDeps,
  input: PhotoQuoteInput,
): Promise<PhotoQuoteResult | null> {
  // 1. Validate the job belongs to the franchisee.
  const feRows = await deps.db
    .select()
    .from(franchisees)
    .where(eq(franchisees.id, input.franchiseeId));
  const fe = feRows[0];
  if (!fe) return null;
  const jobRows = await deps.db
    .select()
    .from(jobs)
    .where(eq(jobs.id, input.jobId));
  const job = jobRows[0];
  if (!job || job.franchiseeId !== input.franchiseeId) return null;

  // 2. Vision.
  const vision = await deps.vision.identify({
    imageRef: input.imageRef,
    description: input.description,
  });

  // 3. Open an ai_conversations row for audit.
  const convRows = await deps.db
    .insert(aiConversations)
    .values({
      franchiseeId: input.franchiseeId,
      capability: 'tech.photoQuote',
      subjectJobId: input.jobId,
    })
    .returning();
  const conversationId = convRows[0]!.id;

  // Persist the vision output as a tool row for audit.
  await deps.db.insert(aiMessages).values({
    conversationId,
    franchiseeId: input.franchiseeId,
    role: 'tool',
    content: vision.rawText,
    toolName: 'vision.identify',
    toolInput: { imageRef: input.imageRef },
    toolOutput: {
      make: vision.make,
      model: vision.model,
      failureMode: vision.failureMode,
      tags: vision.tags,
    },
    confidence: vision.confidence.toFixed(4),
    provider: 'stub-vision',
    model: 'vision-stub-1',
  });

  // 4. RAG retrieval using tags extracted from vision.
  const ragDocs: RetrievedDoc[] = [];
  if (vision.tags.length > 0) {
    const docs = await retrieveKnowledge(
      deps.db,
      {
        franchisorId: fe.franchisorId,
        query: vision.tags.join(' '),
        limit: 5,
      },
      { embedding: deps.embedding },
    );
    ragDocs.push(...docs);
  }

  // 5. Extract SKU tags from RAG hits + vision tags.
  const skuTags = new Set<string>([
    ...extractSkuTags(vision.tags),
    ...ragDocs.flatMap((d) => extractSkuTags(d.tags)),
  ]);
  if (skuTags.size === 0) {
    return { conversationId, vision, candidates: [] };
  }

  // 6. Resolve SKUs against the franchisee's active published
  // template — so suggested items come from their pricebook.
  const templateRows = await deps.db
    .select()
    .from(serviceCatalogTemplates)
    .where(
      and(
        eq(serviceCatalogTemplates.franchisorId, fe.franchisorId),
        eq(serviceCatalogTemplates.status, 'published'),
      ),
    )
    .orderBy(desc(serviceCatalogTemplates.createdAt))
    .limit(1);
  const templateId = templateRows[0]?.id;
  if (!templateId) {
    return { conversationId, vision, candidates: [] };
  }

  const skuArray = [...skuTags];
  const itemRows = await deps.db
    .select()
    .from(serviceItems)
    .where(eq(serviceItems.templateId, templateId));
  const matching = itemRows.filter((r) => skuArray.includes(r.sku));

  // 7. Score each match. Simple scheme: base score is vision
  // confidence, plus 0.05 per supporting KB doc that contained the
  // sku tag, clipped to [0, 1].
  const capCents =
    (fe.aiGuardrails as { techPhotoQuoteCapCents?: number } | null)
      ?.techPhotoQuoteCapCents ?? DEFAULT_CAP_CENTS;

  const candidates: QuoteCandidate[] = [];
  for (const item of matching) {
    const supporting = ragDocs.filter((d) =>
      extractSkuTags(d.tags).includes(item.sku),
    );
    const score = Math.min(
      1,
      Math.max(0, vision.confidence + supporting.length * 0.05),
    );
    const price = await resolveEffectivePrice(
      deps.db as unknown as ScopedTx,
      input.franchiseeId,
      item.id,
    );
    const effective = price?.effective ?? item.basePrice;
    const cents = Math.round(Number(effective) * 100);
    const reasoning = supporting.length
      ? `Vision identified ${vision.failureMode ?? 'an issue'}; KB article "${supporting[0]!.title}" maps to ${item.sku}.`
      : `Vision identified ${vision.failureMode ?? 'an issue'} matching ${item.sku}.`;
    candidates.push({
      serviceItemId: item.id,
      sku: item.sku,
      name: item.name,
      unitPriceDollars: effective,
      confidence: Number(score.toFixed(4)),
      reasoning,
      requiresConfirmation: cents > capCents,
      supportingSources: supporting.slice(0, 3).map((d) => d.source),
    });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const top = candidates.slice(0, 3);

  // Record the final assistant message.
  await deps.db.insert(aiMessages).values({
    conversationId,
    franchiseeId: input.franchiseeId,
    role: 'assistant',
    content: { candidates: top },
    confidence: vision.confidence.toFixed(4),
    provider: 'tech-photo-quote',
    model: 'pipeline-v1',
  });

  return { conversationId, vision, candidates: top };
}

// ---------------------------------------------------------------------------
// notesToInvoice
// ---------------------------------------------------------------------------

export interface NotesToInvoiceInput {
  scope: RequestScope;
  franchiseeId: string;
  jobId: string;
  notes: string;
}

export interface NotesToInvoiceResult {
  conversationId: string;
  description: string;
  intent: string;
  warnings: string[];
}

const NOTES_PROMPT = `You are an AI assistant helping a field technician turn rough
repair notes into a polished, customer-facing description for an invoice.

Rules:
- Keep it to 1-3 short sentences.
- Do not invent parts or prices.
- If the notes mention something unsafe (exposed spring, electrical
  hazard), include a brief warning in the "warnings" array.
- Respond ONLY with JSON shaped:
  { "description": string, "intent": string, "warnings": string[] }`;

export async function techNotesToInvoice(
  deps: TechAssistantDeps,
  input: NotesToInvoiceInput,
): Promise<NotesToInvoiceResult | null> {
  const feRows = await deps.db
    .select()
    .from(franchisees)
    .where(eq(franchisees.id, input.franchiseeId));
  const fe = feRows[0];
  if (!fe) return null;
  const jobRows = await deps.db
    .select()
    .from(jobs)
    .where(eq(jobs.id, input.jobId));
  const job = jobRows[0];
  if (!job || job.franchiseeId !== input.franchiseeId) return null;

  const conv = await deps.db
    .insert(aiConversations)
    .values({
      franchiseeId: input.franchiseeId,
      capability: 'tech.photoQuote',
      subjectJobId: input.jobId,
    })
    .returning();
  const conversationId = conv[0]!.id;

  const turn = await deps.ai.turn({
    systemPrompt: NOTES_PROMPT,
    history: [{ role: 'user', content: input.notes }],
    tools: [],
  });

  let description = 'Repair performed as noted.';
  let intent = 'repair';
  let warnings: string[] = [];
  if (turn.kind === 'text') {
    try {
      // The model is instructed to return JSON; parse defensively.
      const parsed = JSON.parse(turn.text) as {
        description?: string;
        intent?: string;
        warnings?: string[];
      };
      if (typeof parsed.description === 'string')
        description = parsed.description;
      if (typeof parsed.intent === 'string') intent = parsed.intent;
      if (Array.isArray(parsed.warnings))
        warnings = parsed.warnings.map((w) => String(w));
    } catch {
      // Non-JSON text — store as description verbatim.
      description = turn.text;
    }
  }

  await deps.db.insert(aiMessages).values({
    conversationId,
    franchiseeId: input.franchiseeId,
    role: 'assistant',
    content: { description, intent, warnings },
    confidence: '1',
    provider: turn.provider,
    model: turn.model,
    costUsd: turn.costUsd.toFixed(6),
  });

  // Keep unused-import smoothers so future rule expansions don't
  // churn the import list.
  void franchiseAgreements;

  return { conversationId, description, intent, warnings };
}
