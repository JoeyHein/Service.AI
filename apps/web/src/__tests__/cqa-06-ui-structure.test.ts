/**
 * CQA-06 structural tests for the customer accept page + Share UI.
 *
 * File-existence + grep-style assertions, matching the sqb-08 pattern.
 * End-to-end acceptance + deposit behaviour is covered by the API live
 * tests (public-quote routes + deposit/webhook in live-quote-routes).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', '..');
const read = (r: string) => readFileSync(join(WEB, r), 'utf8');
const exists = (r: string) => existsSync(join(WEB, r));

describe('CQA-06 / file existence', () => {
  it.each([
    'src/app/quotes/[token]/accept/page.tsx',
    'src/app/quotes/[token]/accept/AcceptPanel.tsx',
    'src/app/quotes/[token]/accept/CardDepositForm.tsx',
  ])('%s exists', (p) => expect(exists(p)).toBe(true));
});

describe('CQA-06 / accept page', () => {
  const page = read('src/app/quotes/[token]/accept/page.tsx');
  it('fetches the public quote summary by token', () => {
    expect(page).toMatch(/\/api\/v1\/public\/quotes\//);
    expect(page).toMatch(/apiServerFetch/);
  });
  it('renders the AcceptPanel with the publishable key', () => {
    expect(page).toMatch(/AcceptPanel/);
    expect(page).toMatch(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/);
  });
});

describe('CQA-06 / AcceptPanel', () => {
  const src = read('src/app/quotes/[token]/accept/AcceptPanel.tsx');
  it('posts to the public accept route', () => {
    expect(src).toMatch(/\/api\/v1\/public\/quotes\/.+\/accept/);
    expect(src).toMatch(/data-testid="accept-button"/);
  });
  it('gates the deposit form on accepted + deposit due + not paid', () => {
    expect(src).toMatch(/needsDeposit/);
    expect(src).toMatch(/CardDepositForm/);
  });
});

describe('CQA-06 / shared StripeCardForm uses Stripe Elements', () => {
  const src = read('src/lib/StripeCardForm.tsx');
  it('loads Stripe + renders Elements/PaymentElement + confirms', () => {
    expect(src).toMatch(/loadStripe/);
    expect(src).toMatch(/@stripe\/react-stripe-js/);
    expect(src).toMatch(/PaymentElement/);
    expect(src).toMatch(/confirmPayment/);
  });
});

describe('CQA-06 / CardDepositForm wraps the shared form', () => {
  const src = read('src/app/quotes/[token]/accept/CardDepositForm.tsx');
  it('uses StripeCardForm + the deposit-intent endpoint', () => {
    expect(src).toMatch(/StripeCardForm/);
    expect(src).toMatch(/\/api\/v1\/public\/quotes\/.+\/deposit-intent/);
    expect(src).toMatch(/clientSecret/);
  });
});

describe('QF-05 / invoice pay page uses the shared card form', () => {
  it('InvoicePayForm wraps StripeCardForm + the invoice payment-intent endpoint', () => {
    const src = read('src/app/invoices/[id]/pay/InvoicePayForm.tsx');
    expect(src).toMatch(/StripeCardForm/);
    expect(src).toMatch(/\/api\/v1\/public\/invoices\/.+\/payment-intent/);
  });
  it('pay page renders the InvoicePayForm (no more inert stub button)', () => {
    const src = read('src/app/invoices/[id]/pay/page.tsx');
    expect(src).toMatch(/InvoicePayForm/);
    expect(src).toMatch(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/);
  });
});

describe('CQA-06 / Share button on builders', () => {
  it('QuoteBuilder has a Share link button hitting /share', () => {
    const src = read('src/app/(app)/quotes/new/QuoteBuilder.tsx');
    expect(src).toMatch(/data-testid="share-quote"/);
    expect(src).toMatch(/\/api\/v1\/quotes\/.+\/share/);
  });
  it('MobileQuoteBuilder has a Share link button hitting /share', () => {
    const src = read('src/app/tech/jobs/[id]/quote/new/MobileQuoteBuilder.tsx');
    expect(src).toMatch(/data-testid="share-quote"/);
    expect(src).toMatch(/\/api\/v1\/quotes\/.+\/share/);
  });
});
