import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { requireSession } from '../../../../lib/session.js';
import { QuoteBuilder } from './QuoteBuilder';
import type { CatalogItem, CustomerLite, JobLite } from './QuoteBuilder';

interface CustomerDetail {
  id: string;
  name: string;
  emailPrimary?: string | null;
  phonePrimary?: string | null;
}

interface JobDetail {
  id: string;
  customerId: string;
  title?: string | null;
}

/**
 * Stub catalog for the live quote builder.
 *
 * TODO(SQB-09): the real catalog comes from BC AI Agent's `listCatalog`
 * (currently empty) or is mirrored from Service.AI's own pricebook
 * (`packages/db` -> pricebook_items). The supplier provider already
 * accepts arbitrary SKUs in `priceItems`, so this stub is purely a
 * front-end affordance to help dispatchers + managers find the right
 * SKU; the API trusts whatever SKU lands in the request and pulls
 * unit cost from BC's batch-price response.
 */
const STUB_CATALOG: CatalogItem[] = [
  { sku: 'SPRING-200', name: 'Torsion spring 0.250 wire', category: 'springs' },
  { sku: 'SPRING-225', name: 'Torsion spring 0.225 wire', category: 'springs' },
  { sku: 'CABLE-LIFT', name: 'Lift cable pair', category: 'cables' },
  { sku: 'ROLLER-NYL', name: 'Nylon roller (each)', category: 'hardware' },
  { sku: 'HINGE-2', name: 'Hinge #2', category: 'hardware' },
  { sku: 'OPENER-LB', name: 'LiftMaster belt-drive opener', category: 'openers' },
  { sku: 'REMOTE-3BTN', name: '3-button remote', category: 'openers' },
  { sku: 'WEATHERSEAL', name: 'Bottom weatherseal', category: 'seals' },
  { sku: 'PANEL-16x7', name: '16x7 panel', category: 'panels' },
  { sku: 'TRACK-2IN', name: '2" track (set)', category: 'tracks' },
];

/**
 * Live quote builder shell. Reads `?customerId=&jobId=` from the URL,
 * loads the customer + job details, and renders the role-aware client
 * builder. Role-tailored visibility (cost / margin / override pencil)
 * is resolved inside `QuoteBuilder` from the session role passed in.
 */
export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; jobId?: string }>;
}) {
  const session = await requireSession('/quotes/new');
  const sp = await searchParams;
  const customerId = sp.customerId ?? null;
  const jobId = sp.jobId ?? null;

  let customer: CustomerLite | null = null;
  if (customerId) {
    const res = await apiServerFetch<CustomerDetail>(
      `/api/v1/customers/${customerId}`,
    );
    if (res.body.ok && res.body.data) {
      customer = {
        id: res.body.data.id,
        name: res.body.data.name,
        emailPrimary: res.body.data.emailPrimary ?? null,
        phonePrimary: res.body.data.phonePrimary ?? null,
      };
    }
  }

  let job: JobLite | null = null;
  if (jobId) {
    const res = await apiServerFetch<JobDetail>(`/api/v1/jobs/${jobId}`);
    if (res.body.ok && res.body.data) {
      job = {
        id: res.body.data.id,
        customerId: res.body.data.customerId,
        title: res.body.data.title ?? null,
      };
    }
  }

  // Resolve the corporate's default supplier (first row) so the builder can
  // create the draft + check supplier stock. Falls back to null when none is
  // configured (the builder surfaces the "wire a supplier" warning).
  const supRes = await apiServerFetch<{ rows: Array<{ id: string }> }>(
    '/api/v1/suppliers',
  );
  const supplierId: string | null = supRes.body.ok
    ? (supRes.body.data?.rows[0]?.id ?? null)
    : null;

  const role = session.scope?.role ?? 'tech';

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">New quote</h1>
          <p className="mt-1 text-sm text-slate-500">
            Build the line items, watch the price update, and send it to the
            supplier.
          </p>
        </div>
        <Link
          href="/jobs"
          className="text-sm text-blue-700 hover:underline"
        >
          Back to jobs
        </Link>
      </div>
      <div className="mt-6">
        <QuoteBuilder
          role={role}
          customer={customer}
          job={job}
          supplierId={supplierId}
          catalog={STUB_CATALOG}
        />
      </div>
    </section>
  );
}
