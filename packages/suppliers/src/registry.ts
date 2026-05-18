/**
 * ProviderRegistry — keyed lookup by `providerKind`. The API + voice +
 * web layers ask the registry for "the provider for supplier X" rather
 * than instantiating providers directly; this keeps the BcAiAgentProvider
 * concrete impl swappable in tests and lets a future
 * SecondSupplierProvider plug in without touching call sites.
 *
 * Registries are constructed per-process (singleton in the Fastify app
 * factory) and seeded from the `suppliers` table at boot. v1 has exactly
 * one supplier; the shape supports many.
 */
import type { SupplierProvider } from './types.js';

export type SupplierProviderKind = SupplierProvider['providerKind'];

export interface SupplierConfig {
  supplierId: string;
  providerKind: SupplierProviderKind;
  endpointUrl: string;
  apiKey: string;
  supplierAccountCode: string;
}

/**
 * Factory contract — one factory per provider kind. The registry calls
 * the factory once per row in the `suppliers` table and caches the
 * resulting provider instance.
 */
export type SupplierProviderFactory = (config: SupplierConfig) => SupplierProvider;

export class ProviderRegistry {
  private readonly factories = new Map<SupplierProviderKind, SupplierProviderFactory>();
  private readonly providers = new Map<string, SupplierProvider>();

  /** Register the factory for a provider kind. Idempotent — replaces. */
  registerFactory(kind: SupplierProviderKind, factory: SupplierProviderFactory): void {
    this.factories.set(kind, factory);
  }

  /**
   * Build (or fetch the cached) provider for the given config. Throws
   * if no factory has been registered for the kind — registries should
   * be fully wired at app boot before any handler queries them.
   */
  bind(config: SupplierConfig): SupplierProvider {
    const cached = this.providers.get(config.supplierId);
    if (cached) return cached;
    const factory = this.factories.get(config.providerKind);
    if (!factory) {
      throw new Error(
        `No factory registered for supplier provider kind "${config.providerKind}". ` +
          'Did the app forget to call registerFactory before handling a request?',
      );
    }
    const provider = factory(config);
    this.providers.set(config.supplierId, provider);
    return provider;
  }

  /** Read a previously-bound provider by `suppliers.id`. */
  getById(supplierId: string): SupplierProvider | undefined {
    return this.providers.get(supplierId);
  }

  /** Clear the cache — useful between tests. */
  clear(): void {
    this.providers.clear();
  }

  /** For diagnostics: which kinds are registered. */
  registeredKinds(): SupplierProviderKind[] {
    return Array.from(this.factories.keys());
  }
}
