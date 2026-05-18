/**
 * Unit tests for stubStripeClient (TASK-IP-02; trimmed by CHR-08
 * single-account Stripe model).
 */

import { describe, it, expect } from 'vitest';
import { stubStripeClient } from '../stripe.js';

describe('IP-02 / stubStripeClient', () => {
  it('createPaymentIntent echoes amounts + returns pi_stub_* id + client_secret', async () => {
    const pi = await stubStripeClient.createPaymentIntent({
      amount: 10000,
      currency: 'usd',
      metadata: { invoiceId: 'inv_1' },
    });
    expect(pi.id).toMatch(/^pi_stub_/);
    expect(pi.amount).toBe(10000);
    expect(pi.clientSecret).toContain('_secret_stub');
  });

  it('createRefund returns a re_stub_* id and echoes amount', async () => {
    const r = await stubStripeClient.createRefund({
      paymentIntentId: 'pi_stub_abc',
      amount: 2500,
    });
    expect(r.id).toMatch(/^re_stub_/);
    expect(r.amount).toBe(2500);
    expect(r.paymentIntentId).toBe('pi_stub_abc');
  });

  it('constructWebhookEvent parses and returns the event verbatim', () => {
    const raw = JSON.stringify({
      id: 'evt_test',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_stub_x' } },
      created: 1234567890,
    });
    const evt = stubStripeClient.constructWebhookEvent(raw, 'sig-ignored');
    expect(evt.id).toBe('evt_test');
    expect(evt.type).toBe('payment_intent.succeeded');
  });

  it('constructWebhookEvent throws BAD_PAYLOAD on malformed input', () => {
    expect(() =>
      stubStripeClient.constructWebhookEvent('{"type":"x"}', 'sig'),
    ).toThrow(/missing/);
  });
});
