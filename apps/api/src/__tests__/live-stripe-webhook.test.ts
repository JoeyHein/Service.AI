/**
 * Unit tests for the CHR-08 Stripe webhook dispatch logic.
 *
 * The pre-CHR-08 live suite asserted the old per-branch Connect model
 * (account.updated, application_fee_amount, the franchisees table — both
 * the franchisees table and that webhook flow are gone). CHR-08
 * removed all of that — the webhook now writes a `payments` row, marks the
 * invoice paid, and calls the commission engine. We stub the Drizzle
 * surface so the test runs without a live Postgres.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// commission-engine is mocked so we can assert the webhook calls it without
// requiring a real DB or the comp_plans/branch_managers fixtures.
vi.mock('../commission-engine.js', () => ({
  onInvoicePaid: vi.fn(async () => []),
  reverseInvoicePaid: vi.fn(async () => []),
}));

import { registerStripeWebhook } from '../stripe-webhook.js';
import { stubStripeClient } from '../stripe.js';
import { onInvoicePaid, reverseInvoicePaid } from '../commission-engine.js';
import Fastify from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as dbSchema from '@service-ai/db';

interface Calls {
  insertedEvents: Set<string>;
  insertsByTable: Record<string, unknown[]>;
  updatesByTable: Record<string, unknown[]>;
}

/**
 * Tiny Drizzle stand-in tailored to the webhook handler's exact call shapes.
 * Only the fluent chains the handler actually constructs are supported; any
 * other path returns an empty result. The handler is tightly coupled to a
 * few SELECT/INSERT/UPDATE patterns so this stub stays focused.
 */
function buildDbStub(opts: {
  fakeInvoice: { id: string; branchId: string; status: string };
  calls: Calls;
}): NodePgDatabase<typeof dbSchema> {
  const { calls, fakeInvoice } = opts;

  function tableName(table: unknown): string {
    // Drizzle pgTable stores the name on a symbol-keyed property. Look it
    // up via the well-known symbols rather than the brittle `_.name` path.
    const t = table as Record<string | symbol, unknown>;
    for (const sym of Object.getOwnPropertySymbols(t)) {
      const v = t[sym];
      if (typeof v === 'string' && v.length > 0 && v.length < 40) return v;
    }
    return '';
  }

  function makeSelect() {
    return {
      from(table: unknown) {
        const name = tableName(table);
        return {
          where: async () => {
            if (name.includes('invoice')) return [fakeInvoice];
            if (name.includes('payment')) return [{ id: 'pmt_stub_1' }];
            return [];
          },
        };
      },
    };
  }

  function makeInsert(tableName: string) {
    // The chain supports any of: .values().returning(),
    // .values().onConflictDoNothing().returning(),
    // .values().onConflictDoNothing() (awaited directly).
    const stripeEventsInsert = (val: { id: string }) => {
      const isNew = !calls.insertedEvents.has(val.id);
      calls.insertedEvents.add(val.id);
      return isNew ? [{ id: val.id }] : [];
    };
    const wrap = (val: unknown, isStripeEvents: boolean) => {
      const result = isStripeEvents
        ? stripeEventsInsert(val as { id: string })
        : [val];
      const node = {
        onConflictDoNothing: () => node,
        returning: async () => result,
        then(resolve: (v: unknown) => void) {
          resolve(undefined);
        },
      };
      return node;
    };
    return {
      values(val: unknown) {
        (calls.insertsByTable[tableName] ??= []).push(val);
        return wrap(val, tableName === 'stripe_events');
      },
    };
  }

  function makeUpdate(tableName: string) {
    return {
      set(val: unknown) {
        (calls.updatesByTable[tableName] ??= []).push(val);
        return {
          where: async () => undefined,
        };
      },
    };
  }

  function makeDelete(tableName: string) {
    return {
      where: async () => {
        (calls.updatesByTable[`delete:${tableName}`] ??= []).push(true);
      },
    };
  }

  const dbStub = {
    select: () => makeSelect(),
    insert: (table: unknown) => makeInsert(tableName(table)),
    update: (table: unknown) => makeUpdate(tableName(table)),
    delete: (table: unknown) => makeDelete(tableName(table)),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
    execute: async () => undefined,
  };
  return dbStub as unknown as NodePgDatabase<typeof dbSchema>;
}

async function buildHarness(opts: { quoteId?: string | null } = {}) {
  const fakeInvoice = {
    id: '11111111-1111-1111-1111-111111111111',
    branchId: '22222222-2222-2222-2222-222222222222',
    status: 'finalized',
    quoteId: opts.quoteId ?? null,
  };
  const calls: Calls = {
    insertedEvents: new Set(),
    insertsByTable: {},
    updatesByTable: {},
  };
  const db = buildDbStub({ fakeInvoice, calls });
  const app = Fastify({ logger: false });
  registerStripeWebhook(app, db, stubStripeClient);
  await app.ready();
  return { app, fakeInvoice, calls };
}

async function post(app: Awaited<ReturnType<typeof buildHarness>>['app'], body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': 'sig-ignored-by-stub',
    },
    payload: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(onInvoicePaid).mockClear();
  vi.mocked(reverseInvoicePaid).mockClear();
});

describe('CHR-08 / Stripe webhook', () => {
  it('payment_intent.succeeded marks the invoice paid and calls onInvoicePaid', async () => {
    const { app, fakeInvoice, calls } = await buildHarness();
    const res = await post(app, {
      id: 'evt_pi_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_chr8_1',
          amount: 100_00,
          currency: 'usd',
          status: 'succeeded',
          latest_charge: 'ch_chr8_1',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(onInvoicePaid).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onInvoicePaid).mock.calls[0]?.[1]).toBe(fakeInvoice.id);
    // status flipped to paid on the invoice row.
    const invUpdates = (calls.updatesByTable['invoices'] ?? []) as Array<{ status?: string }>;
    expect(invUpdates.some((u) => u.status === 'paid')).toBe(true);
    await app.close();
  });

  it('QF-04: a quote-linked balance invoice does NOT re-credit commission', async () => {
    const { app } = await buildHarness({ quoteId: '33333333-3333-3333-3333-333333333333' });
    const res = await post(app, {
      id: 'evt_pi_balance_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_balance_1',
          amount: 112_50,
          currency: 'cad',
          status: 'succeeded',
          latest_charge: 'ch_balance_1',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    // Commission was already credited at quote commit; the balance payment
    // must not credit again.
    expect(onInvoicePaid).not.toHaveBeenCalled();
    await app.close();
  });

  it('charge.refunded calls reverseInvoicePaid with the refund reason', async () => {
    const { app, fakeInvoice } = await buildHarness();
    const res = await post(app, {
      id: 'evt_rf_1',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_chr8_rf_1',
          payment_intent: 'pi_chr8_1',
          amount_refunded: 100_00,
          refunds: {
            data: [
              { id: 're_chr8_1', amount: 100_00, reason: 'requested_by_customer', status: 'succeeded' },
            ],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(reverseInvoicePaid).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reverseInvoicePaid).mock.calls[0]?.[1]).toBe(fakeInvoice.id);
    expect(vi.mocked(reverseInvoicePaid).mock.calls[0]?.[2]).toBe('invoice_refunded');
    await app.close();
  });

  it('missing stripe-signature → 400', async () => {
    const { app } = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: '{"id":"evt_x","type":"payment_intent.succeeded","data":{"object":{}}}',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('account.updated is no longer dispatched (logged-only default branch)', async () => {
    const { app } = await buildHarness();
    const res = await post(app, {
      id: 'evt_acct_1',
      type: 'account.updated',
      data: { object: { id: 'acct_stub_x' } },
    });
    expect(res.statusCode).toBe(200);
    expect(onInvoicePaid).not.toHaveBeenCalled();
    expect(reverseInvoicePaid).not.toHaveBeenCalled();
    await app.close();
  });
});
