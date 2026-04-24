/**
 * Collections agent prompt library (phase_ai_collections).
 *
 * Three tones:
 *   - friendly (day 7): short nudge, assume the customer forgot.
 *   - firm (day 14): reference the original due date, ask for
 *     a definite payment plan.
 *   - final (day 30): last notice before handoff to human.
 *
 * All three return strict JSON shaped
 *   { "sms": string, "email": { "subject": string, "body": string } }
 * so the API handler can insert directly into collections_drafts.
 */

export type CollectionsTone = 'friendly' | 'firm' | 'final';

export interface CollectionsPromptContext {
  tone: CollectionsTone;
  brandName: string;
  /** Customer display name, first-name preferred. */
  customerName: string;
  invoiceNumber: string;
  /** Dollar amount, already-formatted string like "124.50". */
  amountDue: string;
  daysPastDue: number;
  paymentUrl: string;
  /** Optional franchisor brand voice notes. */
  brandVoice?: string;
}

function toneGuidance(tone: CollectionsTone): string {
  switch (tone) {
    case 'friendly':
      return 'Tone: friendly and brief. Assume the customer forgot.';
    case 'firm':
      return 'Tone: firm and polite. Reference the original due date; ask for a clear commitment to pay.';
    case 'final':
      return 'Tone: final notice. State this is the last AI-sent reminder before a human follows up. Stay professional; no threats.';
  }
}

export function collectionsSystemPrompt(ctx: CollectionsPromptContext): string {
  return [
    `You are ${ctx.brandName}'s AI collections assistant.`,
    '',
    `Customer: ${ctx.customerName}`,
    `Invoice: ${ctx.invoiceNumber}`,
    `Amount due: $${ctx.amountDue}`,
    `Days past due: ${ctx.daysPastDue}`,
    `Payment URL: ${ctx.paymentUrl}`,
    '',
    toneGuidance(ctx.tone),
    ctx.brandVoice
      ? `Brand voice: ${ctx.brandVoice}`
      : 'Brand voice: warm, professional, trades-friendly.',
    '',
    'Rules:',
    '- Keep SMS <= 320 characters and do not include the invoice number twice.',
    '- Email subject should read clearly in a phone preview — <= 70 characters.',
    '- Always include the payment URL.',
    '- Never threaten legal action.',
    '- Respond ONLY with JSON shaped:',
    '  { "sms": "...", "email": { "subject": "...", "body": "..." } }',
  ].join('\n');
}
