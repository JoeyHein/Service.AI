/**
 * Telephony pluggable adapter (Twilio-shaped).
 *
 * The real impl wraps twilio's SDK; the stub returns deterministic
 * ids so tests never hit the network. resolveTelephonyClient()
 * upgrades to the real impl when TWILIO_ACCOUNT_SID +
 * TWILIO_AUTH_TOKEN are set.
 *
 * Signature verification deserves its own note: Twilio signs
 * webhook requests with the HTTP URL, the alphabetised POST
 * params, and the auth token. The adapter takes the raw inputs
 * and returns a boolean; the webhook route rejects on false
 * without ever logging the signature header.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ProvisionNumberInput {
  franchiseeId: string;
  /** Optional area code; falls back to 555. */
  areaCode?: string;
  /** Display name. */
  friendlyName?: string;
}

export interface ProvisionNumberOutput {
  phoneNumberE164: string;
  twilioSid: string;
}

export interface SendSmsInput {
  to: string;
  from: string;
  body: string;
}

export interface InitiateTransferInput {
  callSid: string;
  destination: string;
}

export interface TelephonyClient {
  provisionNumber(input: ProvisionNumberInput): Promise<ProvisionNumberOutput>;
  /**
   * Verify a Twilio webhook request. `params` should include
   * every x-www-form-urlencoded body field in the request,
   * sorted later by the implementation.
   */
  verifyWebhookSignature(input: {
    url: string;
    params: Record<string, string>;
    signature: string;
  }): boolean;
  sendSms(input: SendSmsInput): Promise<{ sid: string }>;
  initiateTransfer(input: InitiateTransferInput): Promise<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

let _stubCounter = 0;
function nextStubSid(prefix: string): string {
  _stubCounter += 1;
  return `${prefix}stub${Date.now().toString(36)}${_stubCounter}`;
}

/**
 * Stub uses a deterministic hash of `franchiseeId` to pick digits
 * for the provisioned number so the same franchisee gets a
 * stable number across reboots. Area code defaults to "555".
 */
export function stubTelephonyClient(): TelephonyClient {
  function hashDigits(seed: string, n: number): string {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) & 0x7fffffff;
    }
    let out = '';
    for (let i = 0; i < n; i++) {
      out += String(h % 10);
      h = Math.floor(h / 10) || 3;
    }
    return out;
  }
  return {
    async provisionNumber({ franchiseeId, areaCode }) {
      const ac = areaCode ?? '555';
      const suffix = hashDigits(franchiseeId, 7);
      return {
        phoneNumberE164: `+1${ac}${suffix}`,
        twilioSid: `PN${nextStubSid('')}`,
      };
    },
    verifyWebhookSignature() {
      // Stub accepts any signature. Tests that want to exercise
      // the rejection path use the real impl or a strict stub.
      return true;
    },
    async sendSms() {
      return { sid: nextStubSid('SM') };
    },
    async initiateTransfer() {
      return { ok: true };
    },
  };
}

/**
 * Strict stub: signature verification rejects everything. Useful
 * for a single test that wants to prove the rejection path runs.
 */
export function strictStubTelephonyClient(): TelephonyClient {
  const base = stubTelephonyClient();
  return { ...base, verifyWebhookSignature: () => false };
}

// ---------------------------------------------------------------------------
// Real (Twilio)
// ---------------------------------------------------------------------------

interface TwilioOpts {
  accountSid: string;
  authToken: string;
  /** Optional messaging service SID; falls back to `from` on sendSms. */
  messagingServiceSid?: string;
}

/**
 * Real impl wraps the `twilio` SDK. Wrapped in a factory so the
 * dep is only loaded when env vars are set (no direct import
 * from the top of this file).
 */
export async function realTelephonyClient(
  opts: TwilioOpts,
): Promise<TelephonyClient> {
  const { default: twilio } = await import('twilio');
  const client = twilio(opts.accountSid, opts.authToken);
  return {
    async provisionNumber({ franchiseeId, areaCode, friendlyName }) {
      const available = await client
        .availablePhoneNumbers('US')
        .local.list({ areaCode: areaCode ? Number(areaCode) : undefined, limit: 1 });
      const candidate = available[0];
      if (!candidate) {
        throw new Error('No available Twilio number in area code');
      }
      const created = await client.incomingPhoneNumbers.create({
        phoneNumber: candidate.phoneNumber,
        friendlyName: friendlyName ?? franchiseeId,
      });
      return {
        phoneNumberE164: created.phoneNumber,
        twilioSid: created.sid,
      };
    },
    verifyWebhookSignature({ url, params, signature }) {
      // Twilio's canonical signature is HMAC-SHA1(authToken, url +
      // sorted param concatenation) base64.
      const keys = Object.keys(params).sort();
      const data = url + keys.map((k) => k + params[k]).join('');
      const expected = createHmac('sha1', opts.authToken)
        .update(data)
        .digest('base64');
      try {
        return timingSafeEqual(
          Buffer.from(signature, 'utf8'),
          Buffer.from(expected, 'utf8'),
        );
      } catch {
        return false;
      }
    },
    async sendSms({ to, from, body }) {
      const msg = await client.messages.create({
        to,
        from: opts.messagingServiceSid ? undefined : from,
        messagingServiceSid: opts.messagingServiceSid,
        body,
      });
      return { sid: msg.sid };
    },
    async initiateTransfer({ callSid, destination }) {
      await client.calls(callSid).update({
        twiml: `<Response><Dial>${destination}</Dial></Response>`,
      });
      return { ok: true };
    },
  };
}

export async function resolveTelephonyClient(): Promise<TelephonyClient> {
  const sid = process.env['TWILIO_ACCOUNT_SID'];
  const token = process.env['TWILIO_AUTH_TOKEN'];
  if (!sid || !token) return stubTelephonyClient();
  return await realTelephonyClient({
    accountSid: sid,
    authToken: token,
    messagingServiceSid: process.env['TWILIO_MESSAGING_SERVICE_SID'],
  });
}
