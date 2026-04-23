import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../../lib/api.js';
import { InvoiceDraftEditor } from './InvoiceDraftEditor';

interface Job {
  id: string;
  title: string;
  status: string;
  customerId: string;
}

interface PricebookRow {
  serviceItemId: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  basePrice: string;
  effectivePrice: string;
  floorPrice: string | null;
  ceilingPrice: string | null;
}

interface Invoice {
  id: string;
  status: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  lines: Array<{
    id: string;
    serviceItemId: string | null;
    sku: string;
    name: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }>;
}

/**
 * Invoice draft editor entry point. Server component fetches the job,
 * the franchisee's resolved pricebook, and any existing draft for the
 * job, then hands those off to the client-side editor.
 *
 * TM-02 ships a working shell so the "Create invoice" link resolves;
 * TM-05b layers the real line-editor UX on top.
 */
export default async function TechInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const jobRes = await apiServerFetch<Job>(`/api/v1/jobs/${encodeURIComponent(id)}`);
  if (jobRes.status !== 200 || !jobRes.body.ok || !jobRes.body.data) notFound();
  const job = jobRes.body.data;

  const pbRes = await apiServerFetch<{ rows: PricebookRow[] }>('/api/v1/pricebook');
  const pricebook =
    pbRes.status === 200 && pbRes.body.data ? pbRes.body.data.rows : [];

  // Existing draft lookup: v1 assumes one draft per job. We don't have
  // a list endpoint yet; the client handles "no draft yet" → POST to
  // create one.
  const existing: Invoice | null = null;

  return (
    <section>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Invoice</h1>
          <p className="mt-0.5 text-xs text-slate-500">{job.title}</p>
        </div>
        <Link
          href={`/tech/jobs/${job.id}`}
          className="text-xs text-slate-600 hover:underline shrink-0"
        >
          ← Job
        </Link>
      </div>

      <InvoiceDraftEditor
        jobId={job.id}
        pricebook={pricebook}
        initialInvoice={existing}
      />
    </section>
  );
}
