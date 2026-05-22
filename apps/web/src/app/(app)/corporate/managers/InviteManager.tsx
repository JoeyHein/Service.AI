'use client';

import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface BranchOption {
  id: string;
  name: string;
}

/**
 * Invite a new manager: mints an invite (role=manager) for a branch. The
 * person accepts at the returned link (signs up with the matching email) and
 * becomes that branch's manager. In production the link is emailed; in dev the
 * email sender is stubbed, so we surface the accept link here directly.
 */
export function InviteManager({ branches }: { branches: BranchOption[] }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    setAcceptUrl(null);
    if (!email.trim() || !branchId) {
      setError('Email and branch are required.');
      return;
    }
    start(async () => {
      const res = await apiClientFetch<{ acceptUrl: string }>('/api/v1/invites', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), role: 'manager', scopeType: 'branch', branchId }),
      });
      if (res.status !== 201 || !res.body.ok || !res.body.data) {
        setError(res.body.error?.message ?? 'Could not create the invite.');
        return;
      }
      setAcceptUrl(res.body.data.acceptUrl);
      setEmail('');
    });
  }

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          data-testid="invite-manager-open"
        >
          + Invite manager
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-medium text-slate-900">Invite a manager</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="new.manager@example.com"
                className="mt-1 block min-w-[18rem] rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="invite-email"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Branch</span>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="mt-1 block rounded border border-slate-300 px-2 py-2 text-sm"
                data-testid="invite-branch"
              >
                {branches.length === 0 && <option value="">No branches</option>}
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="invite-send"
            >
              {pending ? 'Inviting…' : 'Send invite'}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setAcceptUrl(null); setError(null); }}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-xs text-rose-600">{error}</p>}
          {acceptUrl && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
              <p className="font-medium text-emerald-800">Invite created.</p>
              <p className="mt-1 text-xs text-slate-600">
                In production this is emailed. For now, send them this link to accept + set a password:
              </p>
              <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-xs text-slate-700">
                {acceptUrl}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
