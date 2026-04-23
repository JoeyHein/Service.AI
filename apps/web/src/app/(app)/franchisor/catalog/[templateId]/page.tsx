import { notFound } from 'next/navigation';
import Link from 'next/link';
import { apiServerFetch } from '../../../../../lib/api.js';
import { getSession } from '../../../../../lib/session.js';
import { TemplateEditor, type Item, type Template } from './TemplateEditor';

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const session = await getSession();
  if (
    !session ||
    (session.scope?.type !== 'platform' && session.scope?.type !== 'franchisor')
  ) {
    notFound();
  }
  const { templateId } = await params;
  const tRes = await apiServerFetch<Template>(
    `/api/v1/catalog/templates/${encodeURIComponent(templateId)}`,
  );
  if (tRes.status !== 200 || !tRes.body.ok || !tRes.body.data) {
    notFound();
  }
  const template = tRes.body.data;
  const iRes = await apiServerFetch<Item[]>(
    `/api/v1/catalog/templates/${encodeURIComponent(templateId)}/items`,
  );
  const items = iRes.body.ok && iRes.body.data ? iRes.body.data : [];

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{template.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            <span className="font-mono">{template.slug}</span> ·{' '}
            <span
              className={`inline-block px-2 py-0.5 rounded text-xs font-mono ${template.status === 'published' ? 'bg-green-100 text-green-700' : template.status === 'archived' ? 'bg-slate-100 text-slate-500' : 'bg-yellow-100 text-yellow-800'}`}
            >
              {template.status}
            </span>
          </p>
        </div>
        <Link
          href="/franchisor/catalog"
          className="text-sm text-slate-600 hover:underline"
        >
          ← All templates
        </Link>
      </div>
      <TemplateEditor template={template} initialItems={items} />
    </section>
  );
}
