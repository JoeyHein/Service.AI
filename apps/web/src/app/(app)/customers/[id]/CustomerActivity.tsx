'use client';

import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface TimelineRow {
  id: string;
  kind: 'note' | 'job' | 'quote' | 'invoice';
  ts: string;
  subtype: string | null;
  title: string | null;
  detail: string | null;
  status: string | null;
  amount_cents: number | string | null;
  ref: string | null;
}

type Filter = 'all' | 'note' | 'job' | 'quote' | 'invoice';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'note', label: 'Notes' },
  { key: 'job', label: 'Jobs' },
  { key: 'quote', label: 'Quotes' },
  { key: 'invoice', label: 'Invoices' },
];

const NOTE_TYPES = ['call', 'email', 'meeting', 'sms', 'manual'] as const;

const KIND_BADGE: Record<TimelineRow['kind'], string> = {
  note: 'bg-slate-100 text-slate-700',
  job: 'bg-blue-100 text-blue-800',
  quote: 'bg-amber-100 text-amber-800',
  invoice: 'bg-emerald-100 text-emerald-800',
};

function money(cents: number | string | null): string | null {
  if (cents == null) return null;
  const n = typeof cents === 'string' ? Number(cents) : cents;
  if (!Number.isFinite(n)) return null;
  return (n / 100).toLocaleString('en-US', { style: 'currency', currency: 'CAD' });
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Unified customer activity timeline + inline "Add note" composer. Reads from
 * GET /customers/:id/timeline (notes + jobs + quotes + invoices) and posts
 * manual notes to POST /customers/:id/notes.
 */
export function CustomerActivity({
  customerId,
  initialRows,
  initialTotal,
}: {
  customerId: string;
  initialRows: TimelineRow[];
  initialTotal: number;
}) {
  const [rows, setRows] = useState<TimelineRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, startLoading] = useTransition();

  const [noteType, setNoteType] = useState<(typeof NOTE_TYPES)[number]>('call');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function load(next: Filter) {
    setFilter(next);
    startLoading(async () => {
      const qs = next === 'all' ? '' : `?type=${next}`;
      const res = await apiClientFetch<{ rows: TimelineRow[]; total: number }>(
        `/api/v1/customers/${customerId}/timeline${qs}`,
      );
      if (res.status === 200 && res.body.ok && res.body.data) {
        setRows(res.body.data.rows);
        setTotal(res.body.data.total);
      }
    });
  }

  function addNote() {
    if (!body.trim()) return;
    setError(null);
    startSaving(async () => {
      const res = await apiClientFetch(`/api/v1/customers/${customerId}/notes`, {
        method: 'POST',
        body: JSON.stringify({
          noteType,
          subject: subject || null,
          body: body.trim(),
        }),
      });
      if (res.status !== 201) {
        setError(res.body.error?.message ?? 'Could not save note.');
        return;
      }
      setBody('');
      setSubject('');
      load(filter);
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-sm font-medium text-slate-900">Log an interaction</p>
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <select
            value={noteType}
            onChange={(e) => setNoteType(e.target.value as (typeof NOTE_TYPES)[number])}
            className="rounded-md border border-slate-300 px-2 py-2 text-sm"
            data-testid="note-type"
          >
            {NOTE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (optional)"
            className="min-w-[12rem] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What happened?"
            className="min-w-[16rem] flex-[2] rounded-md border border-slate-300 px-3 py-2 text-sm"
            data-testid="note-body"
          />
          <button
            type="button"
            onClick={addNote}
            disabled={saving || !body.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="add-note"
          >
            {saving ? 'Saving…' : 'Add note'}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => load(f.key)}
                className={`rounded-md px-3 py-1 text-sm ${
                  filter === f.key
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                data-testid={`filter-${f.key}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500">
            {loading ? 'Loading…' : `${total} event${total === 1 ? '' : 's'}`}
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            No activity yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const amount = money(r.amount_cents);
              return (
                <li key={`${r.kind}-${r.id}`} className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={`mt-0.5 inline-flex shrink-0 items-center rounded px-2 py-0.5 text-xs font-medium ${KIND_BADGE[r.kind]}`}
                  >
                    {r.kind === 'note' && r.subtype ? r.subtype : r.kind}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {r.title || r.ref || r.kind}
                      </p>
                      <span className="shrink-0 text-xs text-slate-400">{when(r.ts)}</span>
                    </div>
                    {r.detail && (
                      <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{r.detail}</p>
                    )}
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                      {r.status && r.kind !== 'note' && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{r.status}</span>
                      )}
                      {amount && <span className="font-medium text-slate-700">{amount}</span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
