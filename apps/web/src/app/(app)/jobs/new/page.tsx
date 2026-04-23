import { Suspense } from 'react';
import { apiServerFetch } from '../../../../lib/api.js';
import { NewJobForm } from './NewJobForm';

interface CustomerOption {
  id: string;
  name: string;
}

export default async function NewJobPage() {
  const res = await apiServerFetch<{ rows: CustomerOption[] }>(
    '/api/v1/customers?limit=200',
  );
  const customers = res.body.ok && res.body.data ? res.body.data.rows : [];
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">New job</h1>
      <p className="mt-1 text-sm text-slate-500">
        Pick the customer and describe the work. Initial status is unassigned.
      </p>
      <div className="mt-6 max-w-xl">
        <Suspense fallback={null}>
          <NewJobForm customers={customers} />
        </Suspense>
      </div>
    </section>
  );
}
