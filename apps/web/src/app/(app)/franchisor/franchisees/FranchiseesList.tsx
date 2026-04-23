'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface FranchiseeRow {
  id: string;
  name: string;
  slug: string;
}

export function FranchiseesList({ rows }: { rows: FranchiseeRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function viewAs(id: string) {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const res = await fetch('/impersonate/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ franchiseeId: id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(body.error?.message ?? 'Could not start impersonation.');
        setPendingId(null);
        return;
      }
      router.push('/dashboard');
      router.refresh();
    });
  }

  if (rows.length === 0) return null;

  return (
    <>
      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      <ul
        className="mt-6 bg-white rounded-lg border border-slate-200 divide-y divide-slate-200"
        data-testid="franchisees-list"
      >
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between px-4 py-3"
          >
            <div>
              <p className="text-sm font-medium text-slate-900">{row.name}</p>
              <p className="text-xs text-slate-500">{row.slug}</p>
            </div>
            <button
              type="button"
              onClick={() => viewAs(row.id)}
              disabled={pending && pendingId === row.id}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid={`view-as-${row.slug}`}
            >
              {pending && pendingId === row.id ? 'Opening…' : 'View as'}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
