'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export function NewTemplateForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<{ id: string }>('/api/v1/catalog/templates', {
        method: 'POST',
        body: JSON.stringify({ name, slug }),
      });
      if (res.status !== 201) {
        setError(res.body.error?.message ?? 'Create failed.');
        return;
      }
      router.push(`/franchisor/catalog/${res.body.data!.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm">
        <span className="text-slate-700 font-medium">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="text-slate-700 font-medium">Slug</span>
        <input
          required
          pattern="[a-z0-9-]+"
          placeholder="summer-2026"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm font-mono"
        />
        <span className="text-xs text-slate-500 mt-1 block">
          Lower-case, hyphenated.
        </span>
      </label>
      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create template'}
      </button>
    </form>
  );
}
