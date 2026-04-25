/**
 * Email + SMS pluggable notification adapters (phase_invoicing_stripe).
 *
 * Same philosophy as the phase-2 MagicLinkSender: a narrow interface
 * the business code uses, a stub implementation the dev loop + tests
 * rely on, and a real implementation wired from env vars in index.ts.
 * Adding Resend (email) or Twilio (SMS) later is a one-file change
 * — the caller doesn't move.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@service-ai/db';
import { notificationsLog } from '@service-ai/db';
import { logger } from './logger.js';

/**
 * Tenant + related-entity context that the dashboard's
 * notifications_log tile consumes. Optional so tests and legacy
 * non-tenant sends (magic-link verification, etc.) don't have to
 * thread it through.
 */
export interface NotificationContext {
  franchiseeId: string;
  jobId?: string;
  invoiceId?: string;
  customerId?: string;
  relatedKind?: string;
  createdByUserId?: string;
}

export interface EmailPayload {
  to: string;
  subject: string;
  /** Plain text. Providers upgrade to HTML via their templating. */
  text: string;
  /** Correlation hint for observability. */
  tag?: string;
  context?: NotificationContext;
}

export interface SmsPayload {
  to: string;
  body: string;
  tag?: string;
  context?: NotificationContext;
}

export interface EmailSender {
  send(payload: EmailPayload): Promise<{ id: string }>;
}

export interface SmsSender {
  send(payload: SmsPayload): Promise<{ id: string }>;
}

let emailCounter = 0;
let smsCounter = 0;

export const loggingEmailSender: EmailSender = {
  async send(payload) {
    emailCounter += 1;
    const id = `email_stub_${emailCounter}`;
    logger.info({ id, ...payload }, 'email (stub) send');
    return { id };
  },
};

export const loggingSmsSender: SmsSender = {
  async send(payload) {
    smsCounter += 1;
    const id = `sms_stub_${smsCounter}`;
    logger.info({ id, ...payload }, 'sms (stub) send');
    return { id };
  },
};

export function resolveEmailSender(): EmailSender {
  // Resend integration lands with the first real send path
  // (phase_ai_collections). Until then the stub is the only path.
  if (!process.env['RESEND_API_KEY']) return loggingEmailSender;
  return loggingEmailSender;
}

export function resolveSmsSender(): SmsSender {
  // Twilio is already in play for voice (phase_ai_csr_voice) but the
  // SMS trigger is separate and wires in at phase_invoicing_stripe+1.
  if (!process.env['TWILIO_ACCOUNT_SID']) return loggingSmsSender;
  return loggingSmsSender;
}

type Drizzle = NodePgDatabase<typeof schema>;

function previewOf(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Decorates an EmailSender/SmsSender so every successful send also
 * writes a row to notifications_log. Skipped when no context is
 * supplied (legacy paths like magic-link verification). Logging is
 * best-effort: a DB failure logs a warning but never fails the send.
 */
export function withDbLogging(
  db: Drizzle,
  senders: { email: EmailSender; sms: SmsSender },
): { email: EmailSender; sms: SmsSender } {
  return {
    email: {
      async send(payload) {
        const result = await senders.email.send(payload);
        if (payload.context) {
          try {
            await db.insert(notificationsLog).values({
              franchiseeId: payload.context.franchiseeId,
              channel: 'email',
              direction: 'outbound',
              toAddress: payload.to,
              subject: payload.subject,
              bodyPreview: previewOf(payload.text),
              providerRef: result.id,
              jobId: payload.context.jobId,
              invoiceId: payload.context.invoiceId,
              customerId: payload.context.customerId,
              relatedKind: payload.context.relatedKind ?? payload.tag,
              createdByUserId: payload.context.createdByUserId,
              status: 'sent',
            });
          } catch (err) {
            logger.warn({ err }, 'notifications_log insert failed (email)');
          }
        }
        return result;
      },
    },
    sms: {
      async send(payload) {
        const result = await senders.sms.send(payload);
        if (payload.context) {
          try {
            await db.insert(notificationsLog).values({
              franchiseeId: payload.context.franchiseeId,
              channel: 'sms',
              direction: 'outbound',
              toAddress: payload.to,
              bodyPreview: previewOf(payload.body),
              providerRef: result.id,
              jobId: payload.context.jobId,
              invoiceId: payload.context.invoiceId,
              customerId: payload.context.customerId,
              relatedKind: payload.context.relatedKind ?? payload.tag,
              createdByUserId: payload.context.createdByUserId,
              status: 'sent',
            });
          } catch (err) {
            logger.warn({ err }, 'notifications_log insert failed (sms)');
          }
        }
        return result;
      },
    },
  };
}
