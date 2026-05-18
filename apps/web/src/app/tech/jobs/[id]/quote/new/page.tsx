import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../../../lib/api.js';
import { MobileQuoteBuilder, type CatalogItem } from './MobileQuoteBuilder';

interface JobShape {
  id: string;
  customerId: string;
  title: string | null;
}

interface CustomerShape {
  id: string;
  name: string;
  emailPrimary: string | null;
  phonePrimary: string | null;
}

/**
 * Tech mobile quote view (SQB-09).
 *
 * Lives under the tech layout (already gated to role=tech). Mirrors
 * the office `/quotes/new` API contract but reskinned for a phone:
 *   - Vertical line list
 *   - Bottom-sheet SKU picker (no autocomplete-in-row)
 *   - Sticky totals + commit at the viewport bottom
 *   - Offline cache for prices with a "stale" badge
 *   - Commit blocked when navigator.onLine === false
 *
 * Catalog is the same stub as the office view; TODO(SQB-09a) mirrors
 * the BC AI Agent listCatalog OR Service.AI's pricebook once those
 * are wired.
 */
const STUB_CATALOG: CatalogItem[] = [
  { sku: 'GD-STEEL-9X7-INS', name: '9×7 Insulated Steel Door', category: 'door' },
  { sku: 'GD-STEEL-10X8-INS', name: '10×8 Insulated Steel Door', category: 'door' },
  { sku: 'GD-STEEL-16X7-INS', name: '16×7 Insulated Steel Door', category: 'door' },
  { sku: 'GD-ALUM-16X7-FV', name: 'Full-View Aluminum 16×7', category: 'door' },
  { sku: 'GD-WOOD-9X7-SWD', name: 'Sectional Wood 9×7', category: 'door' },
  { sku: 'OP-LM-8500W', name: 'LiftMaster 8500W Opener', category: 'opener' },
  { sku: 'OP-LM-8160W', name: 'LiftMaster 8160W Opener', category: 'opener' },
  { sku: 'SPR-TORSION-KIT', name: 'Torsion Spring Kit', category: 'spring' },
  { sku: 'HK-02', name: 'Hardware Kit HK02', category: 'hardware' },
  { sku: 'HK-03', name: 'Hardware Kit HK03', category: 'hardware' },
  { sku: 'SEAL-WX-18', name: 'Weather Seal 18ft', category: 'seal' },
  { sku: 'REM-3BTN', name: 'Remote, 3-Button', category: 'remote' },
];

export default async function TechQuoteNewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: jobId } = await params;

  const jobRes = await apiServerFetch<JobShape>(`/api/v1/jobs/${jobId}`);
  if (jobRes.status === 404 || !jobRes.body.ok || !jobRes.body.data) {
    notFound();
  }
  const job: JobShape = jobRes.body.data;

  const customerRes = await apiServerFetch<CustomerShape>(
    `/api/v1/customers/${job.customerId}`,
  );
  const customer: CustomerShape | null =
    customerRes.status === 200 && customerRes.body.ok && customerRes.body.data
      ? customerRes.body.data
      : null;

  return (
    <MobileQuoteBuilder
      job={job}
      customer={customer}
      // TODO(SQB-09a): supplier wiring — for now we leave it null and
      // the builder surfaces an inline notice. Once /api/v1/corporate/suppliers
      // or per-branch supplier config lands we resolve it here.
      supplierId={null}
      catalog={STUB_CATALOG}
    />
  );
}
