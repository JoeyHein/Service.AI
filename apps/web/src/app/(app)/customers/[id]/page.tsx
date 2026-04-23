import { notFound } from 'next/navigation';
import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { EditCustomerForm, type Customer } from './EditCustomerForm';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiServerFetch<Customer>(
    `/api/v1/customers/${encodeURIComponent(id)}`,
  );
  if (res.status !== 200 || !res.body.ok || !res.body.data) {
    notFound();
  }
  const customer = res.body.data;

  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">{customer.name}</h1>
        <Link
          href="/customers"
          className="text-sm text-slate-600 hover:underline"
        >
          ← All customers
        </Link>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Created {new Date(customer.createdAt).toLocaleString()}
      </p>
      <div className="mt-6">
        <EditCustomerForm customer={customer} />
      </div>
      <div className="mt-6">
        <Link
          href={`/jobs/new?customerId=${customer.id}`}
          className="text-sm text-blue-700 hover:underline"
        >
          Create a job for this customer →
        </Link>
      </div>
    </section>
  );
}
