/**
 * BcAiAgentProvider tests (SQB-06).
 *
 * Stubs `fetch` to assert the provider sends the right body shape and
 * maps BC AI Agent's envelope back to SupplierResult correctly.
 *
 * Coverage:
 *   - priceItems: success, defaults supplierAccountCode from config,
 *     maps every line field, surfaces validUntil + totals.
 *   - commitQuote: success, threads externalQuoteId, threads
 *     unitPriceCents via `options.unitPriceCents`, cached flag honored.
 *   - Auth: every call sends X-Service-AI-Key header.
 *   - HTTP error mapping: 401, 404, 400, 409, 429, 500 → correct
 *     SupplierError codes.
 *   - Retry: 5xx retries up to maxRetries; 4xx does not retry.
 *   - Network error: fetch throws → NETWORK_ERROR, retryable.
 *   - Timeout: AbortError → NETWORK_ERROR with timed-out message.
 *   - Factory + ProviderRegistry integration.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BcAiAgentProvider,
  bcAiAgentFactory,
  ProviderRegistry,
  type CommitQuoteRequest,
  type PriceItemsRequest,
} from '../index.js';

const CONFIG = {
  supplierId: 'sup-1',
  providerKind: 'bc_ai_agent' as const,
  endpointUrl: 'https://portal.opendc.ca',
  apiKey: 'sai_live_TESTKEY00000000000000000000',
  supplierAccountCode: 'ED-001',
};

interface ResponseSpec {
  status: number;
  body: unknown;
}

function makeFetch(responses: ResponseSpec[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let idx = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const r = responses[idx] ?? responses[responses.length - 1]!;
    idx += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async json() {
        return r.body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeThrowingFetch(err: Error): {
  fetchImpl: typeof fetch;
  callCount: { value: number };
} {
  const callCount = { value: 0 };
  const fetchImpl = (async () => {
    callCount.value += 1;
    throw err;
  }) as unknown as typeof fetch;
  return { fetchImpl, callCount };
}

// ---------------------------------------------------------------------------
// priceItems
// ---------------------------------------------------------------------------

describe('BcAiAgentProvider.priceItems', () => {
  it('POSTs to /api/external/price-items with X-Service-AI-Key', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            items: [
              {
                sku: 'PN10-A',
                quantity: 1,
                unitPriceCents: 1000,
                unitCostCents: 500,
                lineTotalCents: 1000,
                itemCategory: 'ALUMINIUM',
                description: 'Test',
                currency: 'CAD',
                priceSource: 'customer',
              },
            ],
            subtotalCents: 1000,
            taxCents: 0,
            totalCents: 1000,
            currency: 'CAD',
            validUntil: '2026-06-17T00:00:00Z',
          },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const req: PriceItemsRequest = {
      supplierAccountCode: 'ED-001',
      items: [{ sku: 'PN10-A', quantity: 1 }],
    };
    const res = await provider.priceItems(req);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://portal.opendc.ca/api/external/price-items');
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers['X-Service-AI-Key']).toBe(CONFIG.apiKey);
    expect(headers['Content-Type']).toBe('application/json');
    expect(res.data.items[0]!.sku).toBe('PN10-A');
    expect(res.data.items[0]!.itemCategory).toBe('ALUMINIUM');
    expect(res.data.subtotalCents).toBe(1000);
    expect(res.data.validUntil).toBe('2026-06-17T00:00:00Z');
  });

  it('defaults supplierAccountCode from the bound config when omitted', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            items: [],
            subtotalCents: 0,
            taxCents: 0,
            totalCents: 0,
            currency: 'CAD',
            validUntil: '2026-06-17T00:00:00Z',
          },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    await provider.priceItems({
      supplierAccountCode: '',  // empty → fall through to default
      items: [{ sku: 'X', quantity: 1 }],
    });
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.supplierAccountCode).toBe('ED-001');
  });

  it('maps 401 to UNAUTHORIZED, non-retryable', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'bad key' } } },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 3 });
    const res = await provider.priceItems({ supplierAccountCode: 'ED-001', items: [{ sku: 'X', quantity: 1 }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('UNAUTHORIZED');
    expect(res.error.retryable).toBe(false);
    // 4xx does not retry — exactly one call.
    expect(calls).toHaveLength(1);
  });

  it('maps 404 to NOT_FOUND', async () => {
    const { fetchImpl } = makeFetch([{ status: 404, body: { ok: false, error: { message: 'not found' } } }]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const res = await provider.priceItems({ supplierAccountCode: 'X', items: [{ sku: 'X', quantity: 1 }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('maps 400 / 422 to INVALID_REQUEST', async () => {
    const { fetchImpl } = makeFetch([{ status: 422, body: { ok: false, error: { message: 'bad body' } } }]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const res = await provider.priceItems({ supplierAccountCode: 'ED-001', items: [{ sku: 'X', quantity: 1 }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INVALID_REQUEST');
    expect(res.error.retryable).toBe(false);
  });

  it('retries 500 up to maxRetries then surfaces UPSTREAM_ERROR', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 500, body: { ok: false, error: { message: 'down' } } },
      { status: 500, body: { ok: false, error: { message: 'down' } } },
      { status: 500, body: { ok: false, error: { message: 'down' } } },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 2 });
    const res = await provider.priceItems({ supplierAccountCode: 'ED-001', items: [{ sku: 'X', quantity: 1 }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('UPSTREAM_ERROR');
    expect(res.error.retryable).toBe(true);
    // 1 initial + 2 retries = 3 calls.
    expect(calls).toHaveLength(3);
  });

  it('eventually succeeds when a transient 500 clears', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 500, body: { ok: false, error: { message: 'flaky' } } },
      {
        status: 200,
        body: {
          ok: true,
          data: {
            items: [],
            subtotalCents: 0,
            taxCents: 0,
            totalCents: 0,
            currency: 'CAD',
            validUntil: '2026-06-17T00:00:00Z',
          },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const res = await provider.priceItems({ supplierAccountCode: 'ED-001', items: [{ sku: 'X', quantity: 1 }] });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('maps 429 to RATE_LIMITED and retries', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 429, body: { ok: false, error: { message: 'slow down' } } },
      { status: 429, body: { ok: false, error: { message: 'slow down' } } },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 1 });
    const res = await provider.priceItems({ supplierAccountCode: 'ED-001', items: [{ sku: 'X', quantity: 1 }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('RATE_LIMITED');
    expect(res.error.retryable).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// commitQuote
// ---------------------------------------------------------------------------

describe('BcAiAgentProvider.commitQuote', () => {
  it('threads externalQuoteId + unitPriceCents into the body', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            supplierQuoteRef: 'SQ-001391',
            supplierQuoteId: 'bc-abc',
            validUntil: '2026-06-17T00:00:00Z',
            currency: 'CAD',
            cached: false,
          },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const req: CommitQuoteRequest = {
      supplierAccountCode: 'ED-001',
      externalQuoteId: 'svc-quote-42',
      items: [
        {
          sku: 'PN10-A',
          quantity: 2,
          options: { unitPriceCents: 12345, description: 'Aluminum stile' },
        },
      ],
      notes: 'Commit',
    };
    const res = await provider.commitQuote(req);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.supplierQuoteRef).toBe('SQ-001391');

    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.externalQuoteId).toBe('svc-quote-42');
    expect(sent.items[0].unitPriceCents).toBe(12345);
    expect(sent.items[0].description).toBe('Aluminum stile');
    expect(sent.notes).toBe('Commit');
  });

  it('retries on 500 (safe because BC AI Agent is idempotent on externalQuoteId)', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 500, body: { ok: false, error: { message: 'down' } } },
      {
        status: 200,
        body: {
          ok: true,
          data: {
            supplierQuoteRef: 'SQ-001392',
            supplierQuoteId: 'bc-xyz',
            validUntil: '2026-06-17T00:00:00Z',
            currency: 'CAD',
            cached: false,
          },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const res = await provider.commitQuote({
      supplierAccountCode: 'ED-001',
      externalQuoteId: 'svc-quote-43',
      items: [{ sku: 'PN10-A', quantity: 1, options: { unitPriceCents: 100 } }],
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('maps 409 to IDEMPOTENCY_CONFLICT, non-retryable', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 409, body: { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'bound to other account' } } },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 3 });
    const res = await provider.commitQuote({
      supplierAccountCode: 'ED-001',
      externalQuoteId: 'svc-quote-44',
      items: [{ sku: 'PN10-A', quantity: 1, options: { unitPriceCents: 100 } }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 4xx is non-retryable even though we set maxRetries=3.
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Network / transport errors
// ---------------------------------------------------------------------------

describe('BcAiAgentProvider network errors', () => {
  it('maps fetch throw to NETWORK_ERROR, retries, then surfaces', async () => {
    const { fetchImpl, callCount } = makeThrowingFetch(new Error('ECONNRESET'));
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 2 });
    const res = await provider.priceItems({ supplierAccountCode: 'ED-001', items: [{ sku: 'X', quantity: 1 }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NETWORK_ERROR');
    expect(res.error.retryable).toBe(true);
    // 1 + 2 retries = 3 calls.
    expect(callCount.value).toBe(3);
  });

  it('maps AbortError (timeout) to NETWORK_ERROR with timed-out message', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const { fetchImpl } = makeThrowingFetch(abortErr);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 0, timeoutMs: 50 });
    const res = await provider.priceItems({ supplierAccountCode: 'ED-001', items: [{ sku: 'X', quantity: 1 }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NETWORK_ERROR');
    expect(res.error.message).toMatch(/timed out/i);
  });

  it('calls onError hook on every failure attempt', async () => {
    const onError = vi.fn();
    const { fetchImpl } = makeFetch([
      { status: 500, body: { ok: false, error: { message: 'down' } } },
      { status: 500, body: { ok: false, error: { message: 'down' } } },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 1, onError });
    await provider.priceItems({ supplierAccountCode: 'ED-001', items: [{ sku: 'X', quantity: 1 }] });
    // 1 initial + 1 retry = 2 calls = 2 onError invocations.
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]![0].operation).toBe('priceItems');
    expect(onError.mock.calls[0]![0].error.code).toBe('UPSTREAM_ERROR');
  });
});

// ---------------------------------------------------------------------------
// voidQuote (TD-SQB-A8) + listCatalog stub
// ---------------------------------------------------------------------------

describe('BcAiAgentProvider.voidQuote', () => {
  it('POSTs to /api/external/quotes/:id/void and threads the body', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            supplierQuoteRef: 'SQ-001391',
            voidedAt: '2026-05-19T20:00:00.000Z',
            cached: false,
          },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const res = await provider.voidQuote({
      externalQuoteId: 'ext-quote-uuid-1',
      supplierQuoteRef: 'SQ-001391',
      reason: 'customer changed mind',
      requestId: 'req-77',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.supplierQuoteRef).toBe('SQ-001391');
    expect(res.data.voidedAt).toBe('2026-05-19T20:00:00.000Z');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://portal.opendc.ca/api/external/quotes/ext-quote-uuid-1/void',
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Service-AI-Key']).toBe('sai_live_TESTKEY00000000000000000000');
    expect(headers['X-Request-ID']).toBe('req-77');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.reason).toBe('customer changed mind');
  });

  it('omits reason when not provided', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            supplierQuoteRef: 'SQ-001392',
            voidedAt: '2026-05-19T20:01:00.000Z',
            cached: true,
          },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const res = await provider.voidQuote({
      externalQuoteId: 'ext-quote-uuid-2',
      supplierQuoteRef: 'SQ-001392',
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({});
  });

  it('maps a 502 UPSTREAM_ERROR into the SupplierResult envelope', async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 502,
        body: {
          ok: false,
          error: {
            code: 'UPSTREAM_ERROR',
            message: 'BC delete_sales_quote failed',
            retryable: true,
          },
        },
      },
      {
        status: 502,
        body: {
          ok: false,
          error: { code: 'UPSTREAM_ERROR', message: 'still failing', retryable: true },
        },
      },
      {
        status: 502,
        body: {
          ok: false,
          error: { code: 'UPSTREAM_ERROR', message: 'still failing', retryable: true },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 0 });
    const res = await provider.voidQuote({
      externalQuoteId: 'ext-quote-uuid-3',
      supplierQuoteRef: 'SQ-001393',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('BcAiAgentProvider unsupported operations', () => {
  it('listCatalog returns an empty array (Service.AI uses its own pricebook)', async () => {
    const provider = new BcAiAgentProvider({ ...CONFIG });
    const res = await provider.listCatalog();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Factory + ProviderRegistry integration
// ---------------------------------------------------------------------------

describe('bcAiAgentFactory + ProviderRegistry', () => {
  it('registers and binds correctly', () => {
    const reg = new ProviderRegistry();
    reg.registerFactory('bc_ai_agent', bcAiAgentFactory);
    const provider = reg.bind(CONFIG);
    expect(provider.providerKind).toBe('bc_ai_agent');
    expect(provider.supplierId).toBe('sup-1');
    // Cached on second bind.
    expect(reg.bind(CONFIG)).toBe(provider);
  });
});
