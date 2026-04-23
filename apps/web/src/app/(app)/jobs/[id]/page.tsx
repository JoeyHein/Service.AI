import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../lib/api.js';
import { JobTransitionPanel } from './JobTransitionPanel';
import { JobPhotos } from './JobPhotos';

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

export default async function JobDetailPage({
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

  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">{job.title}</h1>
        <Link
          href="/jobs"
          className="text-sm text-slate-600 hover:underline"
        >
          ← All jobs
        </Link>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        <span className="font-mono text-xs">{job.status}</span> · created{' '}
        {new Date(job.createdAt).toLocaleString()}
      </p>
      {job.description && (
        <p className="mt-3 text-sm text-slate-700 whitespace-pre-wrap">
          {job.description}
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <h2 className="text-slate-700 font-medium">Schedule</h2>
          <dl className="mt-2 space-y-1 text-slate-600">
            <div>
              <dt className="inline">Scheduled start: </dt>
              <dd className="inline">
                {job.scheduledStart
                  ? new Date(job.scheduledStart).toLocaleString()
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="inline">Actual start: </dt>
              <dd className="inline">
                {job.actualStart
                  ? new Date(job.actualStart).toLocaleString()
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="inline">Actual end: </dt>
              <dd className="inline">
                {job.actualEnd
                  ? new Date(job.actualEnd).toLocaleString()
                  : '—'}
              </dd>
            </div>
          </dl>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <h2 className="text-slate-700 font-medium">Customer</h2>
          <p className="mt-2 text-slate-600">
            <Link
              href={`/customers/${job.customerId}`}
              className="text-blue-700 hover:underline"
            >
              Open customer →
            </Link>
          </p>
        </div>
      </div>

      <div className="mt-6">
        <JobTransitionPanel jobId={job.id} status={job.status} />
      </div>

      <div className="mt-8">
        <JobPhotos jobId={job.id} initialPhotos={photos} />
      </div>
    </section>
  );
}
