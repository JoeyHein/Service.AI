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
  branchId: string;
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

const SEND_TIMEOUT_MS = 10_000;

/**
 * Real email via Resend's REST API (native fetch, no SDK — same convention
 * as BcAiAgentProvider). Throws on a non-2xx so the caller can surface a
 * failed send; the API key is never logged.
 *
 * @param apiKey RESEND_API_KEY
 * @param from verified sender, e.g. "Elevated Doors <noreply@…>"
 */
export function resendEmailSender(apiKey: string, from: string): EmailSender {
  return {
    async send(payload) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [payload.to],
            subject: payload.subject,
            text: payload.text,
            ...(payload.tag
              ? { tags: [{ name: 'tag', value: payload.tag }] }
              : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`resend send failed: ${res.status} ${previewOf(detail, 300)}`);
        }
        const json = (await res.json().catch(() => ({}))) as { id?: string };
        return { id: json.id ?? 'resend_unknown' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Real SMS via Twilio's Messages REST API (native fetch, HTTP Basic auth).
 * Prefers a Messaging Service SID; falls back to a from-number. Throws on a
 * non-2xx; the auth token is never logged.
 */
export function twilioSmsSender(opts: {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  fromNumber?: string;
}): SmsSender {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    opts.accountSid,
  )}/Messages.json`;
  const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64');
  return {
    async send(payload) {
      const form = new URLSearchParams();
      form.set('To', payload.to);
      form.set('Body', payload.body);
      if (opts.messagingServiceSid) {
        form.set('MessagingServiceSid', opts.messagingServiceSid);
      } else if (opts.fromNumber) {
        form.set('From', opts.fromNumber);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Basic ${auth}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`twilio send failed: ${res.status} ${previewOf(detail, 300)}`);
        }
        const json = (await res.json().catch(() => ({}))) as { sid?: string };
        return { id: json.sid ?? 'twilio_unknown' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Real Resend sender when RESEND_API_KEY is set, else the logging stub.
 * EMAIL_FROM must be a Resend-verified sender; defaults are dev-only.
 */
export function resolveEmailSender(): EmailSender {
  const apiKey = process.env['RESEND_API_KEY'];
  if (!apiKey) return loggingEmailSender;
  const from = process.env['EMAIL_FROM'];
  if (!from) {
    logger.warn('RESEND_API_KEY set but EMAIL_FROM missing — email send disabled (stub)');
    return loggingEmailSender;
  }
  return resendEmailSender(apiKey, from);
}

/**
 * Real Twilio sender when account creds + a route (Messaging Service SID or
 * from-number) are set, else the logging stub.
 */
export function resolveSmsSender(): SmsSender {
  const accountSid = process.env['TWILIO_ACCOUNT_SID'];
  const authToken = process.env['TWILIO_AUTH_TOKEN'];
  const messagingServiceSid = process.env['TWILIO_MESSAGING_SERVICE_SID'];
  const fromNumber = process.env['TWILIO_FROM_NUMBER'];
  if (!accountSid || !authToken || (!messagingServiceSid && !fromNumber)) {
    if (accountSid && authToken) {
      logger.warn('Twilio creds set but no MessagingServiceSid/from-number — SMS send disabled (stub)');
    }
    return loggingSmsSender;
  }
  return twilioSmsSender({ accountSid, authToken, messagingServiceSid, fromNumber });
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
              branchId: payload.context.branchId,
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
              branchId: payload.context.branchId,
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
