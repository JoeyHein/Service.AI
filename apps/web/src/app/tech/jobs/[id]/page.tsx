import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../lib/api.js';
import { StaticMap } from '../../../../components/StaticMap';
import { JobTransitionPanel } from '../../../(app)/jobs/[id]/JobTransitionPanel';
import { JobPhotos } from '../../../(app)/jobs/[id]/JobPhotos';
import { PhotoQuotePanel } from './PhotoQuotePanel';

interface Job {
  id: string;
  customerId: string;
  title: string;
  description: string | null;
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  createdAt: string;
}

interface Photo {
  id: string;
  label: string | null;
  contentType: string | null;
  downloadUrl: string;
  createdAt: string;
}

interface CustomerNote {
  id: string;
  noteType: string;
  subject: string | null;
  body: string;
  source: string;
  occurredAt: string;
}

const NOTE_BADGE: Record<string, string> = {
  call: 'bg-blue-100 text-blue-800',
  email: 'bg-violet-100 text-violet-800',
  meeting: 'bg-amber-100 text-amber-800',
  sms: 'bg-teal-100 text-teal-800',
  manual: 'bg-slate-100 text-slate-700',
};

/**
 * Tech-facing mobile job detail. Single-column layout optimised for a
 * 375–430 px viewport. Reuses JobTransitionPanel and JobPhotos from
 * the office view — same API surface, narrower chrome wrapper.
 */
export default async function TechJobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiServerFetch<Job>(`/api/v1/jobs/${encodeURIComponent(id)}`);
  if (res.status !== 200 || !res.body.ok || !res.body.data) notFound();
  const job = res.body.data;

  const photosRes = await apiServerFetch<Photo[]>(
    `/api/v1/jobs/${encodeURIComponent(id)}/photos`,
  );
  const photos =
    photosRes.status === 200 && photosRes.body.data ? photosRes.body.data : [];

  const customerRes = await apiServerFetch<{
    name: string;
    email: string | null;
    phone: string | null;
    latitude: string | null;
    longitude: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
  }>(`/api/v1/customers/${encodeURIComponent(job.customerId)}`);
  const customer =
    customerRes.status === 200 && customerRes.body.data
      ? customerRes.body.data
      : null;

  // What the office/AI captured on the initial call(s) + other CRM notes.
  const notesRes = await apiServerFetch<{ rows: CustomerNote[] }>(
    `/api/v1/customers/${encodeURIComponent(job.customerId)}/notes?limit=20`,
  );
  const notes =
    notesRes.status === 200 && notesRes.body.data ? notesRes.body.data.rows : [];
  const lat = customer?.latitude ? Number(customer.latitude) : null;
  const lng = customer?.longitude ? Number(customer.longitude) : null;
  const address = customer
    ? [customer.addressLine1, customer.city, customer.state].filter(Boolean).join(', ')
    : null;
  const hasCoords =
    typeof lat === 'number' && Number.isFinite(lat) &&
    typeof lng === 'number' && Number.isFinite(lng);
  const directionsUrl = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}&travelmode=driving`
    : null;

  return (
    <section>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{job.title}</h1>
          <p className="mt-0.5 text-xs font-mono text-slate-500">{job.status}</p>
        </div>
        <Link
          href="/tech"
          className="text-xs text-slate-600 hover:underline shrink-0"
        >
          ← Today
        </Link>
      </div>

      {job.description && (
        <p className="mt-3 text-sm text-slate-700 whitespace-pre-wrap">
          {job.description}
        </p>
      )}

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm">
            <div className="font-medium text-slate-700">Location</div>
            {address ? (
              <div className="text-slate-600">{address}</div>
            ) : (
              <div className="text-slate-500">No address on file</div>
            )}
          </div>
          {directionsUrl && (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="directions-link"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Directions
            </a>
          )}
        </div>
        <div className="mt-3">
          <StaticMap
            latitude={lat}
            longitude={lng}
            address={address || null}
            width={600}
            height={220}
          />
        </div>
      </div>

      {/* Customer + what was captured on the initial call(s). */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3" data-testid="tech-customer-notes">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm">
            <div className="font-medium text-slate-800">{customer?.name ?? 'Customer'}</div>
            {customer?.phone && <div className="text-slate-500">{customer.phone}</div>}
          </div>
          {customer?.phone && (
            <a
              href={`tel:${customer.phone.replace(/[^\d+]/g, '')}`}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Call
            </a>
          )}
        </div>
        <div className="mt-3">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Call &amp; CRM notes
          </div>
          {notes.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No call notes recorded for this customer.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${NOTE_BADGE[n.noteType] ?? NOTE_BADGE['manual']}`}>
                      {n.noteType}
                    </span>
                    {n.subject && <span className="font-medium text-slate-700">{n.subject}</span>}
                    <span className="ml-auto text-xs text-slate-400">
                      {new Date(n.occurredAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-slate-700">{n.body}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-4">
        <JobTransitionPanel jobId={job.id} status={job.status} />
      </div>

      <div className="mt-6">
        <JobPhotos jobId={job.id} initialPhotos={photos} />
      </div>

      <PhotoQuotePanel jobId={job.id} />

      <div className="mt-6 flex justify-end">
        <Link
          href={`/tech/jobs/${job.id}/invoice`}
          data-testid="create-invoice-link"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Create invoice
        </Link>
      </div>
    </section>
  );
}
