'use client';

import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface Exception {
  id: string;
  sku: string;
  description: string | null;
  quantity: string;
  jobId: string | null;
  createdAt: string;
}

function Row({ exc, onDone }: { exc: Exception; onDone: (id: string, label: string) => void }) {
  const [mode, setMode] = useState<'idle' | 'create'>('idle');
  const [name, setName] = useState(exc.description ?? exc.sku);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function create() {
    setError(null);
    start(async () => {
      const res = await apiClientFetch(`/api/v1/inventory/exceptions/${exc.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ create: { sku: exc.sku, name: name || exc.sku } }),
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Could not resolve.');
        return;
      }
      onDone(exc.id, 'Stocked & consumed');
    });
  }

  function ignore() {
    setError(null);
    start(async () => {
      const res = await apiClientFetch(`/api/v1/inventory/exceptions/${exc.id}/ignore`, {
        method: 'POST',
        body: '{}',
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Could not ignore.');
        return;
      }
      onDone(exc.id, 'Ignored');
    });
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            <span className="font-mono font-medium text-slate-900">{exc.sku}</span>
            <span className="ml-2 text-slate-500">×{Number(exc.quantity)}</span>
          </p>
          {exc.description && <p className="text-sm text-slate-600">{exc.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {mode === 'idle' && (
            <>
              <button
                type="button"
                onClick={() => setMode('create')}
                disabled={pending}
                className="rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
                data-testid="exc-create"
              >
                Create stocked item
              </button>
              <button
                type="button"
                onClick={ignore}
                disabled={pending}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                data-testid="exc-ignore"
              >
                Ignore
              </button>
            </>
          )}
        </div>
      </div>
      {mode === 'create' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Item name"
            className="min-w-[14rem] flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={create}
            disabled={pending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Create & consume'}
          </button>
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </li>
  );
}

export function ExceptionsInbox({ initialRows }: { initialRows: Exception[] }) {
  const [rows, setRows] = useState<Exception[]>(initialRows);
  const [done, setDone] = useState<Record<string, string>>({});

  function onDone(id: string, label: string) {
    setDone((prev) => ({ ...prev, [id]: label }));
    setTimeout(() => setRows((prev) => prev.filter((r) => r.id !== id)), 1200);
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
        Nothing to reconcile.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <ul className="divide-y divide-slate-100">
        {rows.map((exc) =>
          done[exc.id] ? (
            <li key={exc.id} className="px-4 py-3 text-sm text-emerald-700">
              {exc.sku} — {done[exc.id]} ✓
            </li>
          ) : (
            <Row key={exc.id} exc={exc} onDone={onDone} />
          ),
        )}
      </ul>
    </div>
  );
}
