/**
 * Unit tests for stubStripeClient (TASK-IP-02).
 *
 * The real Stripe client is exercised end-to-end through the
 * webhook handler and invoice-finalize live tests; here we only
 * verify the stub's shape + deterministic helpers so CI never
 * depends on actual Stripe availability.
 */

import { describe, it, expect } from 'vitest';
import { stubStripeClient } from '../stripe.js';

describe('IP-02 / stubStripeClient', () => {
  it('createConnectAccount returns an acct_stub_* id for each franchisee', async () => {
    const a = await stubStripeClient.createConnectAccount({
      franchiseeId: '00000000-0000-0000-0000-000000000000',
      legalName: 'Denver Doors LLC',
    });
    expect(a.id).toMatch(/^acct_stub_/);
    expect(a.chargesEnabled).toBe(false);
  });

  it('createAccountLink returns a connect.stripe.test URL with an expiresAt', async () => {
    const link = await stubStripeClient.createAccountLink({
      accountId: 'acct_stub_abc',
      returnUrl: 'https://app/return',
      refreshUrl: 'https://app/refresh',
    });
    expect(link.url).toContain('connect.stripe.test');
    expect(link.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('retrieveAccount returns fully-ready when account id ends with _ready', async () => {
    const a = await stubStripeClient.retrieveAccount('acct_stub_abc_ready');
    expect(a.chargesEnabled).toBe(true);
    expect(a.payoutsEnabled).toBe(true);
    expect(a.detailsSubmitted).toBe(true);
  });

  it('createPaymentIntent echoes amounts + returns pi_stub_* id + client_secret', async () => {
    const pi = await stubStripeClient.createPaymentIntent({
      amount: 10000,
      applicationFeeAmount: 500,
      currency: 'usd',
      onBehalfOf: 'acct_stub_x',
      transferDestination: 'acct_stub_x',
      metadata: { invoiceId: 'inv_1' },
    });
    expect(pi.id).toMatch(/^pi_stub_/);
    expect(pi.amount).toBe(10000);
    expect(pi.applicationFeeAmount).toBe(500);
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
