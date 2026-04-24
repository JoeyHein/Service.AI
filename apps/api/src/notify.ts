/**
 * Email + SMS pluggable notification adapters (phase_invoicing_stripe).
 *
 * Same philosophy as the phase-2 MagicLinkSender: a narrow interface
 * the business code uses, a stub implementation the dev loop + tests
 * rely on, and a real implementation wired from env vars in index.ts.
 * Adding Resend (email) or Twilio (SMS) later is a one-file change
 * — the caller doesn't move.
 */

import { logger } from './logger.js';

export interface EmailPayload {
  to: string;
  subject: string;
  /** Plain text. Providers upgrade to HTML via their templating. */
  text: string;
  /** Correlation hint for observability. */
  tag?: string;
}

export interface SmsPayload {
  to: string;
  body: string;
  tag?: string;
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
