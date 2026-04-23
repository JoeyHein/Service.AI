import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  createdAt: string;
}

interface CustomersPayload {
  rows: CustomerRow[];
  total: number;
  limit: number;
  offset: number;
}

const LIMIT = 50;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const oneParam = (k: string) => {
    const v = params[k];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
  };
  const search = oneParam('search') ?? '';
  const page = Math.max(parseInt(oneParam('page') ?? '1', 10) || 1, 1);
  const offset = (page - 1) * LIMIT;

  const q = new URLSearchParams();
  q.set('limit', String(LIMIT));
  q.set('offset', String(offset));
  if (search) q.set('search', search);
  const res = await apiServerFetch<CustomersPayload>(
    `/api/v1/customers?${q.toString()}`,
  );
  const data =
    res.body.ok && res.body.data
      ? res.body.data
      : { rows: [], total: 0, limit: LIMIT, offset };
  const totalPages = Math.max(Math.ceil(data.total / LIMIT), 1);

  function pageLink(p: number): string {
    const qs = new URLSearchParams();
    qs.set('page', String(p));
    if (search) qs.set('search', search);
    return `/customers?${qs.toString()}`;
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Customers</h1>
          <p className="mt-1 text-sm text-slate-500">
            {data.total === 0
              ? 'No customers yet.'
              : `${data.rows.length} of ${data.total}`}
          </p>
        </div>
        <Link
          href="/customers/new"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New customer
        </Link>
      </div>

      <form method="get" className="mt-4 flex gap-2">
        <input
          type="text"
          name="search"
          defaultValue={search}
          placeholder="Search name, email, phone"
          className="flex-1 rounded border border-slate-300 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Search
        </button>
      </form>

      <div
        data-testid="customers-list"
        className="mt-6 bg-white rounded-lg border border-slate-200 overflow-hidden"
      >
        {data.rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            No customers match.
          </div>
        ) : (
          <table className="min-w-full text-sm divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Phone</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">City</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2">
                    <Link
                      href={`/customers/${c.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{c.phone ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-600">{c.email ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {c.city ? `${c.city}${c.state ? `, ${c.state}` : ''}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Link
              href={pageLink(Math.max(page - 1, 1))}
              aria-disabled={page <= 1}
              className={`rounded border px-3 py-1 ${page <= 1 ? 'border-slate-200 text-slate-300 pointer-events-none' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
            >
              Previous
            </Link>
            <Link
              href={pageLink(Math.min(page + 1, totalPages))}
              aria-disabled={page >= totalPages}
              className={`rounded border px-3 py-1 ${page >= totalPages ? 'border-slate-200 text-slate-300 pointer-events-none' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
            >
              Next
            </Link>
          </div>
        </nav>
      )}
    </section>
  );
}
