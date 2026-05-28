/**
 * defaultProviderRegistry wiring (BC rollback symmetry).
 *
 * The production registry must resolve BOTH provider kinds:
 *   - 'bc_ai_agent' — the live supplier bridge.
 *   - 'mock'        — the operational rollback target. Flipping a suppliers
 *                     row's provider_kind to 'mock' degrades it to the
 *                     in-memory MockSupplierProvider when BC is unreachable
 *                     (docs/deploy/PILOT_OPERATIONS.md §3). Before this wiring,
 *                     bind() threw "No factory registered for ... mock".
 *
 * Pure unit test — bind() only constructs providers, no network or DB.
 */
import { describe, it, expect } from 'vitest';
import type { SupplierConfig } from '@service-ai/suppliers';
import { defaultProviderRegistry } from '../quote-routes.js';

const baseConfig: Omit<SupplierConfig, 'providerKind' | 'supplierId'> = {
  endpointUrl: 'https://supplier.local',
  apiKey: 'test-key',
  supplierAccountCode: 'ACC-001',
};

describe('defaultProviderRegistry', () => {
  it("binds provider_kind 'bc_ai_agent' to the BC provider", () => {
    const provider = defaultProviderRegistry().bind({
      ...baseConfig,
      supplierId: '00000000-0000-0000-0000-0000000000a1',
      providerKind: 'bc_ai_agent',
    });
    expect(provider.providerKind).toBe('bc_ai_agent');
  });

  it("binds provider_kind 'mock' to the in-memory mock (rollback target)", () => {
    const provider = defaultProviderRegistry().bind({
      ...baseConfig,
      supplierId: '00000000-0000-0000-0000-0000000000a2',
      providerKind: 'mock',
    });
    expect(provider.providerKind).toBe('mock');
    expect(provider.supplierId).toBe('00000000-0000-0000-0000-0000000000a2');
  });

  it('caches per supplierId (bind twice → same instance)', () => {
    const registry = defaultProviderRegistry();
    const config: SupplierConfig = {
      ...baseConfig,
      supplierId: '00000000-0000-0000-0000-0000000000a3',
      providerKind: 'mock',
    };
    expect(registry.bind(config)).toBe(registry.bind(config));
  });
});
