/**
 * Zod schemas for the corporate-hub comp plan + commission rules.
 *
 * v1 supports three rule kinds:
 *
 *   1. `flat_percent_of_invoice_paid`
 *      `{ kind, percent }` — fires when an invoice transitions to paid.
 *      `commission_cents = round(invoice_total_cents * percent / 100)`.
 *
 *   2. `tiered_percent_of_invoice_paid`
 *      `{ kind, tiers: [{ floorCents, percent }] }` — same trigger as (1)
 *      but the percent comes from the highest tier whose `floorCents` is
 *      <= invoice total. Tiers MUST be sorted ascending by `floorCents`
 *      with no duplicates; the first tier MUST have `floorCents = 0` so
 *      every invoice resolves to exactly one tier.
 *
 *   3. `flat_percent_of_quote_committed`
 *      `{ kind, percent }` — fires when a supplier quote is committed
 *      (CHR + SQB). Pays the closer before the customer pays, so the
 *      commission_ledger row is reversed if the quote is later voided.
 *
 * The DB column is JSONB. These schemas are the only validator the
 * application uses on read AND write: route handlers parse with
 * `parseCommissionRule` and surface field-level errors as `400
 * INVALID_COMP_PLAN`. Domain code that calls `computeCommission` (CHR-05)
 * assumes already-parsed rule shapes.
 */
import { z } from 'zod';

/** Whole-number percentage in [0, 100]. */
export const percentSchema = z
  .number()
  .min(0)
  .max(100)
  .describe('Whole-number percentage in [0, 100].');

/** Non-negative integer cents amount. Used for tier floors and (in v1.5) caps. */
export const centsSchema = z
  .number()
  .int()
  .min(0)
  .describe('Non-negative integer cents.');

export const flatPercentOfInvoicePaidSchema = z
  .object({
    kind: z.literal('flat_percent_of_invoice_paid'),
    percent: percentSchema,
  })
  .strict();
export type FlatPercentOfInvoicePaid = z.infer<typeof flatPercentOfInvoicePaidSchema>;

export const tierSchema = z
  .object({
    floorCents: centsSchema,
    percent: percentSchema,
  })
  .strict();
export type Tier = z.infer<typeof tierSchema>;

export const tieredPercentOfInvoicePaidSchema = z
  .object({
    kind: z.literal('tiered_percent_of_invoice_paid'),
    tiers: z
      .array(tierSchema)
      .min(1)
      .superRefine((tiers, ctx) => {
        if (tiers[0]!.floorCents !== 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['0', 'floorCents'],
            message:
              'First tier must have floorCents = 0 so every invoice resolves to a tier.',
          });
        }
        for (let i = 1; i < tiers.length; i += 1) {
          if (tiers[i]!.floorCents <= tiers[i - 1]!.floorCents) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [String(i), 'floorCents'],
              message:
                'Tiers must be sorted ascending by floorCents with no duplicates.',
            });
          }
        }
      }),
  })
  .strict();
export type TieredPercentOfInvoicePaid = z.infer<
  typeof tieredPercentOfInvoicePaidSchema
>;

export const flatPercentOfQuoteCommittedSchema = z
  .object({
    kind: z.literal('flat_percent_of_quote_committed'),
    percent: percentSchema,
  })
  .strict();
export type FlatPercentOfQuoteCommitted = z.infer<
  typeof flatPercentOfQuoteCommittedSchema
>;

export const commissionRuleSchema = z.discriminatedUnion('kind', [
  flatPercentOfInvoicePaidSchema,
  tieredPercentOfInvoicePaidSchema,
  flatPercentOfQuoteCommittedSchema,
]);
export type CommissionRule = z.infer<typeof commissionRuleSchema>;

export const compPlanKindSchema = z.enum([
  'base_plus_commission',
  'commission_only',
]);
export type CompPlanKind = z.infer<typeof compPlanKindSchema>;

export const compPlanPayPeriodSchema = z.enum(['monthly', 'biweekly']);
export type CompPlanPayPeriod = z.infer<typeof compPlanPayPeriodSchema>;

/**
 * Full comp plan record. The DB row stores `commission_rules` as a JSONB
 * array of one or more rules; the application parses each element with
 * `commissionRuleSchema` so reads fail loudly on malformed legacy data.
 *
 * `base_salary_cents` MUST be 0 when `kind = 'commission_only'`; the
 * validator enforces this with a superRefine.
 */
export const compPlanSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(120),
    kind: compPlanKindSchema,
    baseSalaryCents: centsSchema,
    payPeriod: compPlanPayPeriodSchema,
    commissionRules: z.array(commissionRuleSchema).min(1),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    effectiveTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.kind === 'commission_only' && plan.baseSalaryCents !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseSalaryCents'],
        message: 'commission_only plans must have baseSalaryCents = 0.',
      });
    }
    if (plan.effectiveTo && plan.effectiveFrom > plan.effectiveTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveTo'],
        message: 'effectiveTo must be on or after effectiveFrom.',
      });
    }
  });
export type CompPlan = z.infer<typeof compPlanSchema>;

/**
 * Error returned by parseCommissionRule / parseCompPlan when input does
 * not validate. `code` is the structured error code that the API returns
 * (per the CLAUDE.md envelope rule); `details` carries Zod's field-level
 * issues so the UI can highlight which field failed.
 */
export interface CompPlanValidationError {
  code: 'INVALID_COMP_PLAN' | 'INVALID_COMMISSION_RULE';
  message: string;
  details: Array<{ path: string; message: string }>;
}

function formatZodIssues(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.errors.map((issue) => ({
    path: issue.path.length === 0 ? '<root>' : issue.path.join('.'),
    message: issue.message,
  }));
}

/**
 * Parse one commission rule from `unknown`. Throws a structured
 * CompPlanValidationError on failure that the API surfaces verbatim.
 */
export function parseCommissionRule(input: unknown): CommissionRule {
  const result = commissionRuleSchema.safeParse(input);
  if (!result.success) {
    const err: CompPlanValidationError = {
      code: 'INVALID_COMMISSION_RULE',
      message: 'Commission rule failed validation.',
      details: formatZodIssues(result.error),
    };
    throw err;
  }
  return result.data;
}

/**
 * Parse a comp plan record from `unknown`. Used by `/corporate/comp-plans`
 * POST and PATCH handlers (CHR-06).
 */
export function parseCompPlan(input: unknown): CompPlan {
  const result = compPlanSchema.safeParse(input);
  if (!result.success) {
    const err: CompPlanValidationError = {
      code: 'INVALID_COMP_PLAN',
      message: 'Comp plan failed validation.',
      details: formatZodIssues(result.error),
    };
    throw err;
  }
  return result.data;
}

/**
 * Resolve which percent applies to a given invoice total under a tiered
 * rule. Pure function; the commission engine (CHR-05) calls this to
 * compute the per-invoice commission. Returns 0 when no tier matches —
 * which should be impossible if the rule passed validation (floor[0] = 0
 * is enforced) but the function is safe to call on legacy / unparsed
 * data.
 */
export function tierPercentForAmount(
  rule: TieredPercentOfInvoicePaid,
  amountCents: number,
): number {
  let match = 0;
  for (const tier of rule.tiers) {
    if (amountCents >= tier.floorCents) {
      match = tier.percent;
    } else {
      break;
    }
  }
  return match;
}
