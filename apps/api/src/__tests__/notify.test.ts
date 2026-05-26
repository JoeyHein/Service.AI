import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loggingEmailSender,
  loggingSmsSender,
  resendEmailSender,
  resolveEmailSender,
  resolveSmsSender,
  twilioSmsSender,
} from '../notify.js';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resendEmailSender', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to Resend with bearer auth + payload, returns the id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ id: 're_123' }));
    vi.stubGlobal('fetch', fetchMock);

    const sender = resendEmailSender('rk_test', 'Elevated <no-reply@x.com>');
    const result = await sender.send({
      to: 'cust@x.com',
      subject: 'Your quote',
      text: 'hi',
      tag: 'quote.share',
    });

    expect(result).toEqual({ id: 're_123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer rk_test');
    const sent = JSON.parse(init.body as string);
    expect(sent.from).toBe('Elevated <no-reply@x.com>');
    expect(sent.to).toEqual(['cust@x.com']);
    expect(sent.subject).toBe('Your quote');
    expect(sent.tags).toEqual([{ name: 'tag', value: 'quote.share' }]);
  });

  it('throws on a non-2xx response (without leaking the key)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad sender', { status: 422 })),
    );
    const sender = resendEmailSender('rk_secret', 'a@x.com');
    await expect(sender.send({ to: 'c@x.com', subject: 's', text: 't' })).rejects.toThrow(
      /resend send failed: 422/,
    );
  });
});

describe('twilioSmsSender', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to Twilio with basic auth + MessagingServiceSid, returns the sid', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ sid: 'SM_999' }));
    vi.stubGlobal('fetch', fetchMock);

    const sender = twilioSmsSender({
      accountSid: 'AC_sid',
      authToken: 'tok',
      messagingServiceSid: 'MG_svc',
    });
    const result = await sender.send({ to: '+15551234567', body: 'on our way' });

    expect(result).toEqual({ id: 'SM_999' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_sid/Messages.json');
    expect((init.headers as Record<string, string>)['authorization']).toMatch(/^Basic /);
    const form = new URLSearchParams(init.body as string);
    expect(form.get('To')).toBe('+15551234567');
    expect(form.get('Body')).toBe('on our way');
    expect(form.get('MessagingServiceSid')).toBe('MG_svc');
    expect(form.get('From')).toBeNull();
  });

  it('falls back to From number when no messaging service sid', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ sid: 'SM_1' }));
    vi.stubGlobal('fetch', fetchMock);
    const sender = twilioSmsSender({ accountSid: 'AC', authToken: 't', fromNumber: '+15550000000' });
    await sender.send({ to: '+15551112222', body: 'hi' });
    const form = new URLSearchParams((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(form.get('From')).toBe('+15550000000');
    expect(form.get('MessagingServiceSid')).toBeNull();
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 400 })));
    const sender = twilioSmsSender({ accountSid: 'AC', authToken: 't', fromNumber: '+1' });
    await expect(sender.send({ to: '+1', body: 'x' })).rejects.toThrow(/twilio send failed: 400/);
  });
});

describe('resolveEmailSender', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('EMAIL_FROM', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the logging stub when RESEND_API_KEY is unset', () => {
    expect(resolveEmailSender()).toBe(loggingEmailSender);
  });

  it('returns the stub when the key is set but EMAIL_FROM is missing', () => {
    vi.stubEnv('RESEND_API_KEY', 'rk');
    expect(resolveEmailSender()).toBe(loggingEmailSender);
  });

  it('returns a real sender when key + from are set', () => {
    vi.stubEnv('RESEND_API_KEY', 'rk');
    vi.stubEnv('EMAIL_FROM', 'a@x.com');
    expect(resolveEmailSender()).not.toBe(loggingEmailSender);
  });
});

describe('resolveSmsSender', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_FROM_NUMBER']) {
      vi.stubEnv(k, '');
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the logging stub when creds are missing', () => {
    expect(resolveSmsSender()).toBe(loggingSmsSender);
  });

  it('returns the stub when creds are set but no route (no service sid / from)', () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok');
    expect(resolveSmsSender()).toBe(loggingSmsSender);
  });

  it('returns a real sender when creds + messaging service sid are set', () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok');
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', 'MG');
    expect(resolveSmsSender()).not.toBe(loggingSmsSender);
  });
});
