/**
 * Magic-link / invitation email sender interface.
 *
 * Decouples auth flows from any specific email provider so the same code
 * works across white-label tenants that use different delivery backends
 * (Resend, Postmark, SMTP, etc). Dev builds use `loggingSender` which writes
 * the link to stdout — no network dependency, visible in any terminal.
 *
 * Providers are swapped by passing a different `MagicLinkSender` into the
 * `createAuth` factory. Do not call a provider SDK directly from business
 * code; go through this interface.
 */

export interface MagicLinkPayload {
  email: string;
  url: string;
  /** Free-form tag so senders can branch templates (e.g. 'signin' vs 'invite'). */
  purpose?: 'signin' | 'invite' | 'verify';
}

export interface MagicLinkSender {
  send(payload: MagicLinkPayload): Promise<void>;
}

/**
 * Writes the magic link to stdout. Intended for local dev and CI only.
 * In production, swap for a real sender (Resend, etc).
 */
export const loggingSender: MagicLinkSender = {
  async send({ email, url, purpose }) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'magic_link_stub',
        purpose: purpose ?? 'signin',
        email,
        url,
        note: 'dev/CI stub — no email delivered. Replace with a real sender in production.',
      }),
    );
  },
};
