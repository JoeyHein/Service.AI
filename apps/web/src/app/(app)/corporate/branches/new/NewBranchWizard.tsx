'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiClientFetch } from '../../../../../lib/api.js';

type Step = 'identity' | 'phone' | 'manager' | 'done';

interface ManagerCandidate {
  userId: string;
  name: string | null;
  email: string;
}

const TIMEZONES = [
  'America/Edmonton',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
];

/**
 * Three-step wizard for spinning up a new branch.
 *
 *   1. Identity   — name, slug (auto from name), legal entity, timezone
 *   2. Phone      — manual phone number; PATCH after create
 *      TODO(SQB-bridge): hook back into Twilio provisioning once the
 *      bridge lands.
 *   3. Manager    — typeahead against /api/v1/corporate/managers
 *
 * On submit the wizard calls POST /api/v1/corporate/branches, optionally
 * PATCHes phone, optionally POSTs /managers, then redirects to the
 * detail page.
 */
export function NewBranchWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('identity');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const slugForName = useMemo(
    () =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    [name],
  );
  const effectiveSlug = slugTouched ? slug : slugForName;
  const [legalEntityName, setLegalEntityName] = useState('');
  const [timezone, setTimezone] = useState(TIMEZONES[0]!);

  const [phoneNumber, setPhoneNumber] = useState('');

  const [managerQuery, setManagerQuery] = useState('');
  const [selectedManagerId, setSelectedManagerId] = useState<string | null>(null);
  const [managers, setManagers] = useState<ManagerCandidate[]>([]);

  const [branchId, setBranchId] = useState<string | null>(null);

  // Fetch the manager list when the operator reaches the manager step.
  useEffect(() => {
    if (step !== 'manager') return;
    let cancelled = false;
    (async () => {
      const res = await apiClientFetch<ManagerCandidate[]>(
        '/api/v1/corporate/managers',
      );
      if (cancelled) return;
      if (res.body.ok && Array.isArray(res.body.data)) {
        setManagers(res.body.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  const filteredManagers = useMemo(() => {
    const q = managerQuery.trim().toLowerCase();
    if (!q) return managers.slice(0, 10);
    return managers
      .filter(
        (m) =>
          (m.name ?? '').toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [managerQuery, managers]);

  function submitIdentity() {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<{ id: string }>(
        '/api/v1/corporate/branches',
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            slug: effectiveSlug,
            legalEntityName: legalEntityName || undefined,
            timezone,
          }),
        },
      );
      if (res.status !== 201 || !res.body.data) {
        setError(res.body.error?.message ?? 'Create failed');
        return;
      }
      setBranchId(res.body.data.id);
      setStep('phone');
    });
  }

  function submitPhone() {
    if (!branchId) return;
    setError(null);
    if (!phoneNumber.trim()) {
      setStep('manager');
      return;
    }
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/corporate/branches/${branchId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ phoneNumber }),
        },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Phone update failed');
        return;
      }
      setStep('manager');
    });
  }

  function submitManager() {
    if (!branchId) return;
    setError(null);
    if (!selectedManagerId) {
      finish();
      return;
    }
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/corporate/branches/${branchId}/managers`,
        {
          method: 'POST',
          body: JSON.stringify({ userId: selectedManagerId }),
        },
      );
      if (res.status !== 201) {
        setError(res.body.error?.message ?? 'Manager assignment failed');
        return;
      }
      finish();
    });
  }

  function finish() {
    if (!branchId) return;
    router.push(`/corporate/branches/${branchId}`);
    router.refresh();
  }

  return (
    <div className="mt-6 space-y-4" data-testid="new-branch-wizard">
      <ol className="flex items-center gap-2 text-xs text-slate-500">
        <StepPill label="Identity" active={step === 'identity'} done={branchId !== null} />
        <StepPill label="Phone" active={step === 'phone'} done={step === 'manager' || step === 'done'} />
        <StepPill label="Manager" active={step === 'manager'} done={step === 'done'} />
      </ol>

      {error && (
        <div role="alert" className="text-sm text-red-700">
          {error}
        </div>
      )}

      {step === 'identity' && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-800">1. Identity</h2>
          <Field label="Display name" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="new-branch-name"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="Slug" required hint="lowercase-kebab">
            <input
              type="text"
              value={effectiveSlug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              data-testid="new-branch-slug"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
            />
          </Field>
          <Field label="Legal entity (optional)">
            <input
              type="text"
              value={legalEntityName}
              onChange={(e) => setLegalEntityName(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="Timezone">
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={submitIdentity}
              disabled={pending || !name || !effectiveSlug}
              data-testid="new-branch-submit-identity"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Creating…' : 'Create branch'}
            </button>
          </div>
        </div>
      )}

      {step === 'phone' && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-800">2. Phone number</h2>
          {/* TODO(SQB-bridge): swap the manual input below for the Twilio provisioning flow once the bridge lands. */}
          <p className="text-xs text-slate-500">
            Enter the branch&apos;s primary phone now or skip and add it later.
          </p>
          <Field label="Phone number (E.164)">
            <input
              type="text"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+15551234567"
              data-testid="new-branch-phone"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
            />
          </Field>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep('manager')}
              className="text-sm text-slate-600 hover:underline"
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={submitPhone}
              disabled={pending}
              data-testid="new-branch-submit-phone"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save & continue'}
            </button>
          </div>
        </div>
      )}

      {step === 'manager' && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-800">3. Assign manager</h2>
          <Field label="Search managers by name or email">
            <input
              type="text"
              value={managerQuery}
              onChange={(e) => setManagerQuery(e.target.value)}
              data-testid="new-branch-manager-search"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <ul className="rounded border border-slate-200 divide-y divide-slate-100 max-h-60 overflow-auto">
            {filteredManagers.length === 0 ? (
              <li className="px-3 py-2 text-xs text-slate-500">
                No matching managers.
              </li>
            ) : (
              filteredManagers.map((m) => (
                <li
                  key={m.userId}
                  className={`px-3 py-2 text-sm cursor-pointer ${
                    selectedManagerId === m.userId
                      ? 'bg-blue-50 text-blue-900'
                      : 'hover:bg-slate-50'
                  }`}
                  onClick={() => setSelectedManagerId(m.userId)}
                  data-testid={`manager-option-${m.userId}`}
                >
                  <div className="font-medium">{m.name ?? m.email}</div>
                  <div className="text-xs text-slate-500">{m.email}</div>
                </li>
              ))
            )}
          </ul>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={finish}
              className="text-sm text-slate-600 hover:underline"
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={submitManager}
              disabled={pending}
              data-testid="new-branch-submit-manager"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Assigning…' : 'Finish'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepPill({
  label,
  active,
  done,
}: {
  label: string;
  active: boolean;
  done: boolean;
}) {
  const cls = active
    ? 'bg-blue-600 text-white'
    : done
      ? 'bg-green-600 text-white'
      : 'bg-slate-200 text-slate-600';
  return (
    <li className={`px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>
      {label}
    </li>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="text-slate-700 font-medium">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      {hint && <span className="ml-1 text-xs text-slate-400">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}
