'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  notes: string | null;
  createdAt: string;
}

export function EditCustomerForm({ customer }: { customer: Customer }) {
  const router = useRouter();
  const [name, setName] = useState(customer.name);
  const [email, setEmail] = useState(customer.email ?? '');
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [notes, setNotes] = useState(customer.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [deleting, startDeleting] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    startTransition(async () => {
      const res = await apiClientFetch(`/api/v1/customers/${customer.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          email: email || null,
          phone: phone || null,
          notes: notes || null,
        }),
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Update failed.');
        return;
      }
      setOkMsg('Saved.');
      router.refresh();
    });
  }

  function remove() {
    if (!confirm(`Delete ${customer.name}?`)) return;
    startDeleting(async () => {
      const res = await apiClientFetch(`/api/v1/customers/${customer.id}`, {
        method: 'DELETE',
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Delete failed.');
        return;
      }
      router.push('/customers');
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 max-w-xl">
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Phone</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      {(customer.addressLine1 || customer.city) && (
        <div className="text-xs text-slate-500 border border-slate-200 bg-slate-50 rounded p-2">
          <div>{customer.addressLine1}</div>
          <div>
            {[customer.city, customer.state, customer.postalCode]
              .filter(Boolean)
              .join(', ')}
          </div>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {okMsg && (
        <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700">
          {okMsg}
        </div>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={deleting}
          className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </form>
  );
}
