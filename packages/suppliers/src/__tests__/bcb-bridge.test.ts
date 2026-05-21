/**
 * BCB-01 tests — checkAvailability + createPurchaseOrder on both providers.
 */
import { describe, expect, it } from 'vitest';
import {
  BcAiAgentProvider,
  MockSupplierProvider,
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

describe('BcAiAgentProvider.checkAvailability', () => {
  it('POSTs to /api/external/check-availability and maps the envelope', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            allAvailable: false,
            items: [
              { sku: 'PN10', onHand: 12, available: 12, shortfall: 0, status: 'available', leadTimeDays: 0 },
              { sku: 'PN99', onHand: 0, available: 0, shortfall: 3, status: 'unavailable', leadTimeDays: 7 },
            ],
          },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const res = await provider.checkAvailability({
      supplierAccountCode: '',
      items: [{ sku: 'PN10', quantity: 2 }, { sku: 'PN99', quantity: 3 }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.allAvailable).toBe(false);
      expect(res.data.items[1]!.status).toBe('unavailable');
    }
    expect(calls[0]!.url).toBe('https://portal.opendc.ca/api/external/check-availability');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Service-AI-Key']).toBe(CONFIG.apiKey);
    // Defaults the account code from config.
    expect(JSON.parse(String(calls[0]!.init.body)).supplierAccountCode).toBe('ED-001');
  });
});

describe('BcAiAgentProvider.createPurchaseOrder', () => {
  it('POSTs to /api/external/purchase-orders with Idempotency-Key = externalPoId', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          ok: true,
          data: { supplierPoRef: 'BCPO-104821', supplierPoId: 'bc-uuid', createdAt: '2026-05-21T00:00:00Z', cached: false },
        },
      },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl });
    const res = await provider.createPurchaseOrder({
      supplierAccountCode: 'ED-001',
      externalPoId: 'po-uuid-1',
      poNumber: 'PO-000123',
      lines: [{ sku: 'PN10', quantity: 5, unitCostCents: 700 }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.supplierPoRef).toBe('BCPO-104821');
    expect(calls[0]!.url).toBe('https://portal.opendc.ca/api/external/purchase-orders');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('po-uuid-1');
  });

  it('maps a 409 to IDEMPOTENCY_CONFLICT (no retry)', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 409, body: { ok: false, error: { message: 'in progress' } } },
    ]);
    const provider = new BcAiAgentProvider({ ...CONFIG, fetchImpl, maxRetries: 2 });
    const res = await provider.createPurchaseOrder({
      supplierAccountCode: 'ED-001',
      externalPoId: 'po-uuid-2',
      lines: [{ sku: 'X', quantity: 1, unitCostCents: 1 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(calls.length).toBe(1); // 4xx does not retry
  });
});

describe('MockSupplierProvider availability + PO', () => {
  it('availability: catalog SKU available, unknown SKU unavailable, shortfall when over stock', async () => {
    const mock = new MockSupplierProvider({
      catalog: [{ sku: 'IN-STOCK', name: 'x', category: 'c', unitPriceCents: 100, unitCostCents: 50 }],
    });
    const res = await mock.checkAvailability({
      supplierAccountCode: 'ED-001',
      items: [
        { sku: 'IN-STOCK', quantity: 10 },
        { sku: 'IN-STOCK', quantity: 200 },
        { sku: 'UNKNOWN', quantity: 1 },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.items[0]!.status).toBe('available');
      expect(res.data.items[1]!.status).toBe('partial'); // 200 > 100 on-hand
      expect(res.data.items[2]!.status).toBe('unavailable');
      expect(res.data.allAvailable).toBe(false);
    }
  });

  it('createPurchaseOrder is idempotent on externalPoId', async () => {
    const mock = new MockSupplierProvider();
    const req = {
      supplierAccountCode: 'ED-001',
      externalPoId: 'po-1',
      lines: [{ sku: 'A', quantity: 2, unitCostCents: 100 }],
    };
    const first = await mock.createPurchaseOrder(req);
    const second = await mock.createPurchaseOrder(req);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.data.supplierPoRef).toBe(first.data.supplierPoRef);
      expect(first.data.supplierPoRef).toMatch(/^BCPO-\d{6}$/);
    }
  });

  it('createPurchaseOrder surfaces an injected failure', async () => {
    const mock = new MockSupplierProvider();
    mock.injectFailure('createPurchaseOrder', { code: 'UPSTREAM_ERROR', message: 'BC down', retryable: true });
    const res = await mock.createPurchaseOrder({
      supplierAccountCode: 'ED-001',
      externalPoId: 'po-2',
      lines: [{ sku: 'A', quantity: 1, unitCostCents: 1 }],
    });
    expect(res.ok).toBe(false);
  });
});
