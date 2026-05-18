'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { BranchRow } from './page';

type SortKey = 'name' | 'revenue' | 'commission';

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-amber-100 text-amber-800',
  closed: 'bg-slate-200 text-slate-700',
};

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export function BranchesTable({ rows }: { rows: BranchRow[] }) {
  const [sort, setSort] = useState<SortKey>('name');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sort === 'name') cmp = a.name.localeCompare(b.name);
      else if (sort === 'revenue')
        cmp = a.revenueMtdCents - b.revenueMtdCents;
      else cmp = a.commissionPaidMtdCents - b.commissionPaidMtdCents;
      return dir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort, dir]);

  function flip(next: SortKey) {
    if (sort === next) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(next);
      setDir(next === 'name' ? 'asc' : 'desc');
    }
  }

  return (
    <div
      data-testid="branches-table"
      className="overflow-hidden rounded-lg border border-slate-200 bg-white"
    >
      <table className="min-w-full text-sm divide-y divide-slate-200">
        <thead className="bg-slate-50 text-left text-slate-600">
          <tr>
            <Th label="Branch" active={sort === 'name'} dir={dir} onClick={() => flip('name')} />
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Manager</th>
            <Th label="Revenue MTD" active={sort === 'revenue'} dir={dir} onClick={() => flip('revenue')} align="right" />
            <Th label="Commission MTD" active={sort === 'commission'} dir={dir} onClick={() => flip('commission')} align="right" />
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                No branches yet.
              </td>
            </tr>
          ) : (
            sorted.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">
                  <Link
                    href={`/corporate/branches/${r.id}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {r.name}
                  </Link>
                  <div className="text-xs text-slate-500 font-mono">{r.slug}</div>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status] ?? STATUS_BADGE['closed']}`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {r.currentManagerName ?? <span className="text-slate-400">—</span>}
                </td>
                <td className="px-3 py-2 text-right">{money(r.revenueMtdCents)}</td>
                <td className="px-3 py-2 text-right">{money(r.commissionPaidMtdCents)}</td>
                <td className="px-3 py-2 text-right">
                  <Link
                    href={`/corporate/branches/${r.id}`}
                    data-testid={`view-as-${r.slug}`}
                    className="text-xs font-medium text-blue-700 hover:underline"
                  >
                    View as →
                  </Link>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  label,
  active,
  dir,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 ${active ? 'text-slate-900' : ''}`}
      >
        {label}
        {active && <span>{dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  );
}
