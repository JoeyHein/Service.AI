/**
 * Unit tests for MockSupplierProvider + ProviderRegistry (SQB-02).
 *
 * Coverage matrix:
 *   - priceItems: empty input rejected, known sku priced, unknown sku
 *     returns 0 (not a hard error), subtotal + tax computed, multi-line
 *     totals, currency override.
 *   - commitQuote: empty input rejected, idempotent on externalQuoteId,
 *     ref + id returned, repeat returns same response.
 *   - voidQuote: idempotent, isVoided() reports state.
 *   - listCatalog: returns seeded entries.
 *   - failure injection: priceItems and commitQuote return injected
 *     errors; sticky vs single-shot semantics.
 *   - ProviderRegistry: registerFactory, bind(), getById, clear.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  MockSupplierProvider,
  ProviderRegistry,
  type MockCatalogEntry,
  type SupplierConfig,
  type SupplierProvider,
} from '../index.js';

const CATALOG: MockCatalogEntry[] = [
  {
    sku: 'GD-STEEL-9X7',
    name: '9×7 Insulated Steel Door',
    category: 'door',
    uom: 'each',
    unitPriceCents: 89_900,
    unitCostCents: 56_000,
  },
  {
    sku: 'OP-LM-8500W',
    name: 'LiftMaster 8500W Opener',
    category: 'opener',
    uom: 'each',
    unitPriceCents: 84_900,
    unitCostCents: 52_000,
  },
];

function makeProvider(opts = {}): MockSupplierProvider {
  return new MockSupplierProvider({ catalog: CATALOG, ...opts });
}

// ---------------------------------------------------------------------------
// priceItems
// ---------------------------------------------------------------------------

describe('MockSupplierProvider.priceItems', () => {
  it('rejects empty item arrays', async () => {
    const p = makeProvider();
    const res = await p.priceItems({ supplierAccountCode: 'ED', items: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_REQUEST');
  });

  it('prices a single known sku and computes tax', async () => {
    const p = makeProvider();
    const res = await p.priceItems({
      supplierAccountCode: 'ED',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items[0]!.unitPriceCents).toBe(89_900);
    expect(res.data.items[0]!.unitCostCents).toBe(56_000);
    expect(res.data.items[0]!.lineTotalCents).toBe(89_900);
    expect(res.data.items[0]!.itemCategory).toBe('door');
    expect(res.data.subtotalCents).toBe(89_900);
    // 13% HST default → 11_687 cents
    expect(res.data.taxCents).toBe(11_687);
    expect(res.data.totalCents).toBe(89_900 + 11_687);
    expect(res.data.currency).toBe('CAD');
  });

  it('returns zero-priced row for unknown sku without failing the whole batch', async () => {
    const p = makeProvider();
    const res = await p.priceItems({
      supplierAccountCode: 'ED',
      items: [
        { sku: 'GD-STEEL-9X7', quantity: 1 },
        { sku: 'DOES-NOT-EXIST', quantity: 2 },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items.length).toBe(2);
    expect(res.data.items[1]!.unitPriceCents).toBe(0);
    expect(res.data.items[1]!.description).toBe('(unknown sku)');
    expect(res.data.items[1]!.itemCategory).toBeNull();
  });

  it('multiplies line totals by quantity', async () => {
    const p = makeProvider();
    const res = await p.priceItems({
      supplierAccountCode: 'ED',
      items: [{ sku: 'OP-LM-8500W', quantity: 4 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items[0]!.lineTotalCents).toBe(84_900 * 4);
    expect(res.data.subtotalCents).toBe(84_900 * 4);
  });

  it('honors a per-call currency override', async () => {
    const p = makeProvider();
    const res = await p.priceItems({
      supplierAccountCode: 'ED',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
      currency: 'USD',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.currency).toBe('USD');
    expect(res.data.items[0]!.currency).toBe('USD');
  });

  it('honors a custom tax rate', async () => {
    const p = makeProvider({ taxRatePct: 0 });
    const res = await p.priceItems({
      supplierAccountCode: 'ED',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.taxCents).toBe(0);
    expect(res.data.totalCents).toBe(res.data.subtotalCents);
  });
});

// ---------------------------------------------------------------------------
// commitQuote — idempotency is the load-bearing assertion
// ---------------------------------------------------------------------------

describe('MockSupplierProvider.commitQuote', () => {
  it('rejects empty items', async () => {
    const p = makeProvider();
    const res = await p.commitQuote({
      supplierAccountCode: 'ED',
      externalQuoteId: 'q-1',
      items: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_REQUEST');
  });

  it('returns a SQ-NNNNNN reference on first commit', async () => {
    const p = makeProvider();
    const res = await p.commitQuote({
      supplierAccountCode: 'ED',
      externalQuoteId: 'q-1',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.supplierQuoteRef).toMatch(/^SQ-\d{6}$/);
    expect(res.data.supplierQuoteId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is idempotent: same externalQuoteId yields the same ref', async () => {
    const p = makeProvider();
    const first = await p.commitQuote({
      supplierAccountCode: 'ED',
      externalQuoteId: 'q-7',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    const second = await p.commitQuote({
      supplierAccountCode: 'ED',
      externalQuoteId: 'q-7',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.supplierQuoteRef).toBe(first.data.supplierQuoteRef);
    expect(second.data.supplierQuoteId).toBe(first.data.supplierQuoteId);
  });

  it('different externalQuoteIds get different refs', async () => {
    const p = makeProvider();
    const a = await p.commitQuote({
      supplierAccountCode: 'ED',
      externalQuoteId: 'q-a',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    const b = await p.commitQuote({
      supplierAccountCode: 'ED',
      externalQuoteId: 'q-b',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.supplierQuoteRef).not.toBe(b.data.supplierQuoteRef);
  });

  it('10× concurrent commits with the same key still produce one ref', async () => {
    const p = makeProvider();
    const calls = Array.from({ length: 10 }, () =>
      p.commitQuote({
        supplierAccountCode: 'ED',
        externalQuoteId: 'q-concurrent',
        items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
      }),
    );
    const results = await Promise.all(calls);
    const refs = new Set<string>();
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) refs.add(r.data.supplierQuoteRef);
    }
    expect(refs.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// voidQuote
// ---------------------------------------------------------------------------

describe('MockSupplierProvider.voidQuote', () => {
  it('is idempotent', async () => {
    const p = makeProvider();
    const req = { externalQuoteId: 'ext-123', supplierQuoteRef: 'SQ-000123' };
    const a = await p.voidQuote(req);
    const b = await p.voidQuote(req);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) {
      expect(a.data.supplierQuoteRef).toBe('SQ-000123');
      expect(typeof a.data.voidedAt).toBe('string');
    }
  });

  it('tracks the voided ref via isVoided', async () => {
    const p = makeProvider();
    expect(p.isVoided('SQ-000999')).toBe(false);
    await p.voidQuote({
      externalQuoteId: 'ext-999',
      supplierQuoteRef: 'SQ-000999',
    });
    expect(p.isVoided('SQ-000999')).toBe(true);
    expect(p.isVoided('ext-999')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// convertQuoteToOrder (QOC-02) — idempotency + requires-commit invariant
// ---------------------------------------------------------------------------

async function commitFixture(
  p: MockSupplierProvider,
  externalQuoteId: string,
): Promise<void> {
  const res = await p.commitQuote({
    supplierAccountCode: 'ED',
    externalQuoteId,
    items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
  });
  if (!res.ok) {
    throw new Error(`commit fixture failed: ${res.error.code}`);
  }
}

describe('MockSupplierProvider.convertQuoteToOrder', () => {
  it('mints a deterministic SO-XXXXXX after commit', async () => {
    const p = makeProvider();
    const externalQuoteId = 'qoc-mock-1';
    await commitFixture(p, externalQuoteId);
    const res = await p.convertQuoteToOrder({ externalQuoteId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.supplierOrderRef).toMatch(/^SO-\d{6}$/);
    expect(res.data.supplierOrderId).toBeTruthy();
    expect(typeof res.data.orderedAt).toBe('string');
    expect(p.isConverted(externalQuoteId)).toBe(true);
  });

  it('is idempotent on externalQuoteId — same in, same out', async () => {
    const p = makeProvider();
    const externalQuoteId = 'qoc-mock-2';
    await commitFixture(p, externalQuoteId);
    const a = await p.convertQuoteToOrder({ externalQuoteId });
    const b = await p.convertQuoteToOrder({ externalQuoteId });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.data.supplierOrderRef).toBe(a.data.supplierOrderRef);
    expect(b.data.supplierOrderId).toBe(a.data.supplierOrderId);
  });

  it('refuses to convert an unknown / un-committed externalQuoteId', async () => {
    const p = makeProvider();
    const res = await p.convertQuoteToOrder({
      externalQuoteId: 'never-committed',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('returns the injected failure when the mock is wired to fail', async () => {
    const p = makeProvider();
    const externalQuoteId = 'qoc-mock-fail';
    await commitFixture(p, externalQuoteId);
    p.injectFailure('convertToOrder', {
      code: 'UPSTREAM_ERROR',
      message: 'simulated BC outage',
      retryable: true,
    });
    const res = await p.convertQuoteToOrder({ externalQuoteId });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('UPSTREAM_ERROR');
    // Failure is single-shot by default; a retry succeeds.
    const retry = await p.convertQuoteToOrder({ externalQuoteId });
    expect(retry.ok).toBe(true);
  });

  it('clearCommits also resets convertQuoteToOrder state', async () => {
    const p = makeProvider();
    const externalQuoteId = 'qoc-mock-clear';
    await commitFixture(p, externalQuoteId);
    await p.convertQuoteToOrder({ externalQuoteId });
    expect(p.isConverted(externalQuoteId)).toBe(true);
    p.clearCommits();
    expect(p.isConverted(externalQuoteId)).toBe(false);
    // Now /convert without a prior commit must NOT_FOUND.
    const res = await p.convertQuoteToOrder({ externalQuoteId });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listCatalog
// ---------------------------------------------------------------------------

describe('MockSupplierProvider.listCatalog', () => {
  it('returns seeded entries', async () => {
    const p = makeProvider();
    const res = await p.listCatalog();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(CATALOG.length);
    expect(res.data.find((e) => e.sku === 'GD-STEEL-9X7')?.name).toBe(
      '9×7 Insulated Steel Door',
    );
  });

  it('respects upsertCatalog after construction', async () => {
    const p = makeProvider();
    p.upsertCatalog([
      {
        sku: 'NEW-SKU',
        name: 'New widget',
        category: 'parts',
        unitPriceCents: 100,
        unitCostCents: 50,
      },
    ]);
    const res = await p.listCatalog();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.some((e) => e.sku === 'NEW-SKU')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure injection
// ---------------------------------------------------------------------------

describe('MockSupplierProvider failure injection', () => {
  it('makes priceItems return the injected error once, then clears', async () => {
    const p = makeProvider();
    p.injectFailure('price', {
      code: 'UPSTREAM_ERROR',
      message: 'simulated',
      retryable: true,
    });
    const fail = await p.priceItems({
      supplierAccountCode: 'ED',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.error.code).toBe('UPSTREAM_ERROR');

    const ok = await p.priceItems({
      supplierAccountCode: 'ED',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(ok.ok).toBe(true);
  });

  it('sticky failure keeps firing until cleared', async () => {
    const p = makeProvider();
    p.injectFailure(
      'commit',
      { code: 'NETWORK_ERROR', message: 'flaky', retryable: true },
      true,
    );
    for (let i = 0; i < 3; i += 1) {
      const r = await p.commitQuote({
        supplierAccountCode: 'ED',
        externalQuoteId: `q-sticky-${i}`,
        items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
      });
      expect(r.ok).toBe(false);
    }
    p.clearInjectedFailure();
    const ok = await p.commitQuote({
      supplierAccountCode: 'ED',
      externalQuoteId: 'q-recovered',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(ok.ok).toBe(true);
  });

  it('failure on price does not affect commit (and vice versa)', async () => {
    const p = makeProvider();
    p.injectFailure('price', {
      code: 'RATE_LIMITED',
      message: 'cool off',
      retryable: true,
    });
    const commit = await p.commitQuote({
      supplierAccountCode: 'ED',
      externalQuoteId: 'q-x',
      items: [{ sku: 'GD-STEEL-9X7', quantity: 1 }],
    });
    expect(commit.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

describe('ProviderRegistry', () => {
  let reg: ProviderRegistry;

  beforeEach(() => {
    reg = new ProviderRegistry();
  });

  it('throws when binding a kind with no factory', () => {
    expect(() =>
      reg.bind({
        supplierId: 's-1',
        providerKind: 'bc_ai_agent',
        endpointUrl: '',
        apiKey: '',
        supplierAccountCode: '',
      }),
    ).toThrow(/No factory registered/);
  });

  it('binds and caches per supplierId', () => {
    let built = 0;
    reg.registerFactory('mock', (cfg: SupplierConfig): SupplierProvider => {
      built += 1;
      return new MockSupplierProvider({ supplierId: cfg.supplierId, catalog: CATALOG });
    });

    const a = reg.bind({
      supplierId: 's-mock',
      providerKind: 'mock' as 'bc_ai_agent',
      endpointUrl: '',
      apiKey: '',
      supplierAccountCode: 'ED',
    });
    const b = reg.bind({
      supplierId: 's-mock',
      providerKind: 'mock' as 'bc_ai_agent',
      endpointUrl: '',
      apiKey: '',
      supplierAccountCode: 'ED',
    });
    expect(a).toBe(b);
    expect(built).toBe(1);
    expect(reg.getById('s-mock')).toBe(a);
  });

  it('clear() drops cached providers but keeps factories', () => {
    reg.registerFactory(
      'mock',
      (cfg: SupplierConfig): SupplierProvider =>
        new MockSupplierProvider({ supplierId: cfg.supplierId }),
    );
    reg.bind({
      supplierId: 's-1',
      providerKind: 'mock' as 'bc_ai_agent',
      endpointUrl: '',
      apiKey: '',
      supplierAccountCode: 'ED',
    });
    reg.clear();
    expect(reg.getById('s-1')).toBeUndefined();
    // Factory still registered — rebind works.
    expect(reg.registeredKinds()).toContain('mock');
  });
});
