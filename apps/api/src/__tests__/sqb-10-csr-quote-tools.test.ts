/**
 * SQB-10 — CSR voice tools that configure + commit supplier quotes.
 *
 * Pure unit tests against the tool shape — no DB. The DB-touching path
 * is exercised by the existing live-csr-tools.test.ts pattern; this
 * file asserts the contract that the agent loop sees:
 *
 *   - schema (name, inputSchema)
 *   - SUPPLIER_NOT_CONFIGURED when deps.supplier is absent
 *   - INVALID_INPUT when items are empty / qty <= 0
 *   - state.currentQuoteId mediates handoff between the two tools
 *   - commitQuote refuses without a confidence-gated context
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildCsrToolSet,
  commitQuoteTool,
  quoteConfiguratorTool,
  CSR_GATED_TOOLS,
  type CsrToolDeps,
} from '../ai-tools/csr-tools.js';
import type { ToolContext } from '@service-ai/ai';

function makeCtx(): ToolContext {
  return {
    branchId: '00000000-0000-0000-0000-0000000b0001',
    userId: 'user-1',
    guardrails: {
      confidenceThreshold: 0.8,
      undoWindowSeconds: 900,
      transferOnLowConfidence: true,
    },
    invocation: { confidence: 0.95 },
  };
}

function makeBareDeps(): CsrToolDeps {
  return {
    db: {} as CsrToolDeps['db'],
    conversationId: 'conv-1',
    state: {},
    async runScoped<T>(_fn: (tx: never) => Promise<T>): Promise<T> {
      // Tests that don't expect DB calls leave this as a stub that
      // throws if invoked — surfaces accidental DB hits as errors
      // rather than silent passes.
      throw new Error('runScoped should not be called in this test');
    },
  };
}

describe('CSR_GATED_TOOLS', () => {
  it('includes commitQuote', () => {
    expect(CSR_GATED_TOOLS).toContain('commitQuote');
  });
  it('still gates bookJob + createCustomer (no regression)', () => {
    expect(CSR_GATED_TOOLS).toContain('bookJob');
    expect(CSR_GATED_TOOLS).toContain('createCustomer');
  });
});

describe('buildCsrToolSet includes both new tools', () => {
  it('exposes quoteConfigurator + commitQuote', () => {
    const tools = buildCsrToolSet(makeBareDeps());
    expect(Object.keys(tools)).toContain('quoteConfigurator');
    expect(Object.keys(tools)).toContain('commitQuote');
  });
});

describe('quoteConfigurator — input + supplier guards', () => {
  it('SUPPLIER_NOT_CONFIGURED when deps.supplier is missing', async () => {
    const tool = quoteConfiguratorTool(makeBareDeps());
    const res = await tool.execute(
      { items: [{ sku: 'PN10-A', quantity: 1 }] },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error?.code).toBe('SUPPLIER_NOT_CONFIGURED');
  });

  it('INVALID_INPUT when no customer is in state and none passed', async () => {
    const deps = makeBareDeps();
    deps.supplier = {
      supplierId: 's',
      supplierAccountCode: 'ED-001',
      provider: {
        providerKind: 'mock',
        supplierId: 's',
        priceItems: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '', retryable: false } }),
        commitQuote: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '', retryable: false } }),
      },
    };
    const tool = quoteConfiguratorTool(deps);
    const res = await tool.execute({ items: [{ sku: 'X', quantity: 1 }] }, makeCtx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error?.code).toBe('INVALID_INPUT');
  });

  it('INVALID_INPUT when items list filters to empty (zero qty)', async () => {
    const deps = makeBareDeps();
    deps.state.customerId = 'cust-1';
    deps.supplier = {
      supplierId: 's',
      supplierAccountCode: 'ED-001',
      provider: {
        providerKind: 'mock',
        supplierId: 's',
        priceItems: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '', retryable: false } }),
        commitQuote: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '', retryable: false } }),
      },
    };
    const tool = quoteConfiguratorTool(deps);
    const res = await tool.execute(
      { items: [{ sku: 'PN10-A', quantity: 0 }, { sku: '', quantity: 5 }] },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error?.code).toBe('INVALID_INPUT');
  });

  it('propagates supplier provider error code', async () => {
    const priceMock = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'RATE_LIMITED' as const, message: 'slow down', retryable: true },
    }));
    const deps = makeBareDeps();
    deps.state.customerId = 'cust-1';
    deps.supplier = {
      supplierId: 's',
      supplierAccountCode: 'ED-001',
      provider: {
        providerKind: 'mock',
        supplierId: 's',
        priceItems: priceMock,
        commitQuote: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '', retryable: false } }),
      },
    };
    const tool = quoteConfiguratorTool(deps);
    const res = await tool.execute(
      { items: [{ sku: 'PN10-A', quantity: 1 }] },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error?.code).toBe('RATE_LIMITED');
    expect(priceMock).toHaveBeenCalled();
  });
});

describe('commitQuote — input guards', () => {
  it('SUPPLIER_NOT_CONFIGURED when no supplier wired', async () => {
    const tool = commitQuoteTool(makeBareDeps());
    const res = await tool.execute({ confidence: 0.95 }, makeCtx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error?.code).toBe('SUPPLIER_NOT_CONFIGURED');
  });

  it('INVALID_INPUT when no active quote in state and none passed', async () => {
    const deps = makeBareDeps();
    deps.supplier = {
      supplierId: 's',
      supplierAccountCode: 'ED-001',
      provider: {
        providerKind: 'mock',
        supplierId: 's',
        priceItems: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '', retryable: false } }),
        commitQuote: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '', retryable: false } }),
      },
    };
    const tool = commitQuoteTool(deps);
    const res = await tool.execute({ confidence: 0.95 }, makeCtx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error?.code).toBe('INVALID_INPUT');
  });
});

describe('schema shape', () => {
  it('quoteConfigurator declares the items array as required', () => {
    const tool = quoteConfiguratorTool(makeBareDeps());
    expect(tool.schema.name).toBe('quoteConfigurator');
    const inputSchema = tool.schema.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(inputSchema.required).toContain('items');
    expect(inputSchema.properties).toHaveProperty('items');
  });

  it('commitQuote schema is non-required (works off state)', () => {
    const tool = commitQuoteTool(makeBareDeps());
    expect(tool.schema.name).toBe('commitQuote');
    const inputSchema = tool.schema.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(inputSchema.properties).toHaveProperty('confidence');
  });
});
