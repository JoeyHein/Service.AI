'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

interface Candidate {
  placeId: string;
  description: string;
}

interface PlaceDetails {
  formattedAddress: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string;
}

/**
 * Controlled create form with Google Places autocomplete via the
 * server's stub/real PlacesClient. Typing in the address field debounces
 * a call to /api/v1/places/autocomplete; selecting a candidate fills the
 * split address fields from /api/v1/places/:placeId.
 */
export function NewCustomerForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const [addressQuery, setAddressQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [selectedDetails, setSelectedDetails] = useState<PlaceDetails | null>(null);

  const debouncer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debouncer.current) clearTimeout(debouncer.current);
    // Autocomplete only fires for >=3 char queries with no active
    // selection. The candidate list is cleared directly by the input
    // onChange + the pick() handler, not by this effect — React 19's
    // react-hooks/set-state-in-effect lint rule discourages calling
    // setState from an effect body, so the effect is input-only and
    // doesn't "reconcile" state.
    if (selectedPlaceId) return;
    const q = addressQuery.trim();
    if (q.length < 3) return;
    let cancelled = false;
    debouncer.current = setTimeout(async () => {
      const res = await apiClientFetch<{ candidates: Candidate[] }>(
        `/api/v1/places/autocomplete?q=${encodeURIComponent(q)}`,
      );
      if (cancelled) return;
      if (res.status === 200 && res.body.data) {
        setCandidates(res.body.data.candidates);
      }
    }, 250);
    return () => {
      cancelled = true;
      if (debouncer.current) clearTimeout(debouncer.current);
    };
  }, [addressQuery, selectedPlaceId]);

  async function pick(candidate: Candidate) {
    setSelectedPlaceId(candidate.placeId);
    setCandidates([]);
    setAddressQuery(candidate.description);
    const res = await apiClientFetch<PlaceDetails>(
      `/api/v1/places/${encodeURIComponent(candidate.placeId)}`,
    );
    if (res.status === 200 && res.body.data) {
      setSelectedDetails(res.body.data);
    }
  }

  const addressPreview = useMemo(() => {
    if (!selectedDetails) return null;
    return (
      <div
        data-testid="place-preview"
        className="mt-2 text-xs text-slate-500 border border-slate-200 rounded p-2 bg-slate-50"
      >
        <div>{selectedDetails.addressLine1}</div>
        <div>
          {[selectedDetails.city, selectedDetails.state, selectedDetails.postalCode]
            .filter(Boolean)
            .join(', ')}
        </div>
        {selectedDetails.latitude != null && (
          <div>
            {selectedDetails.latitude.toFixed(4)}, {selectedDetails.longitude?.toFixed(4)}
          </div>
        )}
      </div>
    );
  }, [selectedDetails]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const body: Record<string, unknown> = { name };
      if (email) body.email = email;
      if (phone) body.phone = phone;
      if (selectedDetails) {
        body.placeId = selectedDetails.placeId;
        body.addressLine1 = selectedDetails.addressLine1;
        body.city = selectedDetails.city;
        body.state = selectedDetails.state;
        body.postalCode = selectedDetails.postalCode;
        body.country = selectedDetails.country;
        body.latitude = selectedDetails.latitude;
        body.longitude = selectedDetails.longitude;
      }
      const res = await apiClientFetch<{ id: string }>('/api/v1/customers', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.status !== 201) {
        setError(res.body.error?.message ?? 'Could not create customer.');
        return;
      }
      router.push(`/customers/${res.body.data!.id}`);
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
        <span className="text-sm font-medium text-slate-700">Address</span>
        <input
          value={addressQuery}
          placeholder="Start typing…"
          data-testid="address-query"
          onChange={(e) => {
            setAddressQuery(e.target.value);
            setSelectedPlaceId(null);
            setSelectedDetails(null);
            if (e.target.value.trim().length < 3) setCandidates([]);
          }}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      {candidates.length > 0 && (
        <ul
          data-testid="place-candidates"
          className="border border-slate-200 rounded bg-white divide-y divide-slate-100"
        >
          {candidates.map((c) => (
            <li key={c.placeId}>
              <button
                type="button"
                onClick={() => pick(c)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
              >
                {c.description}
              </button>
            </li>
          ))}
        </ul>
      )}
      {addressPreview}

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
        {pending ? 'Creating…' : 'Create customer'}
      </button>
    </form>
  );
}
