import { notFound } from 'next/navigation';
import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { getSession } from '../../../../lib/session.js';
import { NewTemplateForm } from './NewTemplateForm';

interface Template {
  id: string;
  name: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export default async function CatalogPage() {
  const session = await getSession();
  if (
    !session ||
    (session.scope?.type !== 'platform' && session.scope?.type !== 'franchisor')
  ) {
    notFound();
  }
  const res = await apiServerFetch<Template[]>('/api/v1/catalog/templates');
  const templates = res.body.ok && res.body.data ? res.body.data : [];

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Catalog templates</h1>
          <p className="mt-1 text-sm text-slate-500">
            {templates.length === 0
              ? 'No templates yet — create one below.'
              : `${templates.length} template${templates.length === 1 ? '' : 's'}.`}
          </p>
        </div>
      </div>

      <div
        data-testid="template-list"
        className="mt-6 bg-white rounded-lg border border-slate-200 overflow-hidden"
      >
        {templates.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            No templates yet.
          </div>
        ) : (
          <table className="min-w-full text-sm divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Slug</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Published</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {templates.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-2">
                    <Link
                      href={`/franchisor/catalog/${t.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">{t.slug}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-mono ${t.status === 'published' ? 'bg-green-100 text-green-700' : t.status === 'archived' ? 'bg-slate-100 text-slate-500' : 'bg-yellow-100 text-yellow-800'}`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-500">
                    {t.publishedAt ? new Date(t.publishedAt).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-8 max-w-xl">
        <h2 className="text-sm font-medium text-slate-700">New template</h2>
        <p className="mt-1 text-xs text-slate-500">
          Drafts can be edited until published. Publishing atomically
          archives the currently-published template.
        </p>
        <div className="mt-3">
          <NewTemplateForm />
        </div>
      </div>
    </section>
  );
}
