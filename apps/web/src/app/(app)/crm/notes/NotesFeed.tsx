'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface FeedRow {
  id: string;
  branchId: string;
  customerId: string | null;
  customerName: string | null;
  noteType: string;
  subject: string | null;
  body: string;
  source: string;
  matchKey: string | null;
  matchKeyType: string | null;
  occurredAt: string;
  createdAt: string;
}

type TypeFilter = 'all' | 'call' | 'email' | 'meeting' | 'sms';
type MatchFilter = 'all' | 'matched' | 'unmatched';

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All types' },
  { key: 'call', label: 'Calls' },
  { key: 'email', label: 'Emails' },
  { key: 'meeting', label: 'Meetings' },
  { key: 'sms', label: 'SMS' },
];

const MATCH_FILTERS: { key: MatchFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'matched', label: 'Matched' },
  { key: 'unmatched', label: 'Needs triage' },
];

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface CustomerHit {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

function LinkCustomer({
  noteId,
  onLinked,
}: {
  noteId: string;
  onLinked: (customerName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [searching, startSearch] = useTransition();
  const [linking, startLink] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function search(value: string) {
    setQ(value);
    if (value.trim().length < 2) {
      setHits([]);
      return;
    }
    startSearch(async () => {
      const res = await apiClientFetch<{ rows: CustomerHit[] }>(
        `/api/v1/customers?search=${encodeURIComponent(value.trim())}&limit=8`,
      );
      if (res.status === 200 && res.body.ok && res.body.data) {
        setHits(res.body.data.rows);
      }
    });
  }

  function link(hit: CustomerHit) {
    setError(null);
    startLink(async () => {
      const res = await apiClientFetch(`/api/v1/crm/notes/${noteId}/link`, {
        method: 'POST',
        body: JSON.stringify({ customerId: hit.id }),
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Link failed.');
        return;
      }
      onLinked(hit.name);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
        data-testid="link-open"
      >
        Link to customer
      </button>
    );
  }

  return (
    <div className="w-64">
      <input
        autoFocus
        value={q}
        onChange={(e) => search(e.target.value)}
        placeholder="Search customers…"
        className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
        data-testid="link-search"
      />
      {searching && <p className="mt-1 text-xs text-slate-400">Searching…</p>}
      {hits.length > 0 && (
        <ul className="mt-1 max-h-44 overflow-auto rounded-md border border-slate-200 bg-white text-sm shadow">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => link(h)}
                disabled={linking}
                className="block w-full px-2 py-1.5 text-left hover:bg-slate-50 disabled:opacity-50"
              >
                <span className="font-medium text-slate-800">{h.name}</span>
                {(h.email || h.phone) && (
                  <span className="ml-1 text-xs text-slate-400">
                    {h.email ?? h.phone}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </div>
  );
}

export function NotesFeed({
  initialRows,
  initialTotal,
}: {
  initialRows: FeedRow[];
  initialTotal: number;
}) {
  const [rows, setRows] = useState<FeedRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [type, setType] = useState<TypeFilter>('all');
  const [match, setMatch] = useState<MatchFilter>('all');
  const [loading, startLoading] = useTransition();
  const [linkedIds, setLinkedIds] = useState<Record<string, string>>({});

  function load(nextType: TypeFilter, nextMatch: MatchFilter) {
    setType(nextType);
    setMatch(nextMatch);
    startLoading(async () => {
      const params = new URLSearchParams({ limit: '50' });
      if (nextType !== 'all') params.set('type', nextType);
      if (nextMatch !== 'all') params.set('matched', nextMatch);
      const res = await apiClientFetch<{ rows: FeedRow[]; total: number }>(
        `/api/v1/crm/notes-feed?${params.toString()}`,
      );
      if (res.status === 200 && res.body.ok && res.body.data) {
        setRows(res.body.data.rows);
        setTotal(res.body.data.total);
        setLinkedIds({});
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => load(f.key, match)}
              className={`rounded-md px-3 py-1 text-sm ${
                type === f.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
              data-testid={`type-${f.key}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-slate-300">|</span>
        <div className="flex gap-1">
          {MATCH_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => load(type, f.key)}
              className={`rounded-md px-3 py-1 text-sm ${
                match === f.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
              data-testid={`match-${f.key}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-slate-500">
          {loading ? 'Loading…' : `${total} note${total === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">No notes.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const linkedName = linkedIds[r.id];
              const unmatched = r.customerId === null && !linkedName;
              return (
                <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 inline-flex shrink-0 items-center rounded bg-slate-100 px-2 py-0.5 text-xs font-medium uppercase text-slate-700">
                    {r.noteType}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {linkedName ? (
                          linkedName
                        ) : r.customerId && r.customerName ? (
                          <Link href={`/customers/${r.customerId}`} className="hover:underline">
                            {r.customerName}
                          </Link>
                        ) : (
                          <span className="text-amber-700">
                            Unmatched{r.matchKey ? ` · ${r.matchKey}` : ''}
                          </span>
                        )}
                      </p>
                      <span className="shrink-0 text-xs text-slate-400">{when(r.occurredAt)}</span>
                    </div>
                    {r.subject && (
                      <p className="text-sm font-medium text-slate-700">{r.subject}</p>
                    )}
                    <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{r.body}</p>
                    <div className="mt-1 flex items-center gap-3">
                      <span className="text-xs text-slate-400">{r.source}</span>
                      {unmatched && (
                        <LinkCustomer
                          noteId={r.id}
                          onLinked={(name) =>
                            setLinkedIds((prev) => ({ ...prev, [r.id]: name }))
                          }
                        />
                      )}
                      {linkedName && (
                        <span className="text-xs text-emerald-700">Linked ✓</span>
                      )}
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
