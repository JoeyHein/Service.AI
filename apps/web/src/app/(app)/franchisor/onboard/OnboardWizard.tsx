'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiClientFetch } from '../../../../lib/api.js';

interface WizardState {
  franchiseeId: string | null;
  name: string;
  slug: string;
  legalEntityName: string;
  locationName: string;
  timezone: string;
  areaCode: string;
  phoneNumber: string | null;
  stripeOnboardingUrl: string | null;
  firstStaffEmail: string;
  firstStaffRole: 'franchisee_owner' | 'location_manager' | 'dispatcher' | 'tech' | 'csr';
  inviteId: string | null;
}

const STORAGE_KEY = 'service-ai.onboard-wizard.v1';

const DEFAULT_STATE: WizardState = {
  franchiseeId: null,
  name: '',
  slug: '',
  legalEntityName: '',
  locationName: '',
  timezone: 'America/Denver',
  areaCode: '555',
  phoneNumber: null,
  stripeOnboardingUrl: null,
  firstStaffEmail: '',
  firstStaffRole: 'franchisee_owner',
  inviteId: null,
};

type Step = 'basics' | 'phone' | 'stripe' | 'invite' | 'done';

export function OnboardWizard() {
  const router = useRouter();
  const [state, setState] = useState<WizardState>(DEFAULT_STATE);
  const [step, setStep] = useState<Step>('basics');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Persist to localStorage so a page reload doesn't lose progress.
  // Reading via useEffect happens on mount — we batch the restores
  // in a functional update to avoid the react-hooks/set-state-in-effect
  // warning for cascading renders.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { state: WizardState; step: Step };
      queueMicrotask(() => {
        setState(parsed.state);
        setStep(parsed.step);
      });
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state, step }),
    );
  }, [state, step]);

  function submitBasics() {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<{ id: string }>(
        '/api/v1/franchisor/onboard',
        {
          method: 'POST',
          body: JSON.stringify({
            name: state.name,
            slug: state.slug,
            legalEntityName: state.legalEntityName || undefined,
            locationName: state.locationName || undefined,
            timezone: state.timezone,
          }),
        },
      );
      if (res.status !== 201 || !res.body.data) {
        setError(res.body.error?.message ?? 'Create failed');
        return;
      }
      setState((s) => ({ ...s, franchiseeId: res.body.data!.id }));
      setStep('phone');
    });
  }

  function provisionPhone() {
    if (!state.franchiseeId) return;
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<{ phoneNumberE164: string }>(
        `/api/v1/franchisees/${state.franchiseeId}/phone/provision`,
        {
          method: 'POST',
          body: JSON.stringify({ areaCode: state.areaCode }),
        },
      );
      if (res.status !== 200 && res.status !== 201) {
        setError(res.body.error?.message ?? 'Provision failed');
        return;
      }
      setState((s) => ({
        ...s,
        phoneNumber: res.body.data?.phoneNumberE164 ?? null,
      }));
      setStep('stripe');
    });
  }

  function startStripe() {
    if (!state.franchiseeId) return;
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<{ onboardingUrl: string }>(
        `/api/v1/franchisees/${state.franchiseeId}/connect/onboard`,
        { method: 'POST', body: '{}' },
      );
      if (res.status !== 200 || !res.body.data) {
        setError(res.body.error?.message ?? 'Stripe start failed');
        return;
      }
      setState((s) => ({
        ...s,
        stripeOnboardingUrl: res.body.data!.onboardingUrl,
      }));
      setStep('invite');
    });
  }

  function sendInvite() {
    if (!state.franchiseeId || !state.firstStaffEmail) return;
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<{ id: string }>('/api/v1/invites', {
        method: 'POST',
        body: JSON.stringify({
          email: state.firstStaffEmail,
          role: state.firstStaffRole,
          franchiseeId: state.franchiseeId,
        }),
      });
      if (res.status !== 201 && res.status !== 200) {
        setError(res.body.error?.message ?? 'Invite failed');
        return;
      }
      setState((s) => ({ ...s, inviteId: res.body.data?.id ?? null }));
      setStep('done');
    });
  }

  function finish() {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    router.push('/franchisor');
    router.refresh();
  }

  function skip(next: Step) {
    setStep(next);
  }

  return (
    <div className="mt-6 space-y-4" data-testid="onboard-wizard">
      <ol className="flex items-center gap-2 text-xs text-slate-500">
        <StepPill label="Basics" active={step === 'basics'} done={state.franchiseeId !== null} />
        <StepPill label="Phone" active={step === 'phone'} done={state.phoneNumber !== null} />
        <StepPill label="Stripe" active={step === 'stripe'} done={state.stripeOnboardingUrl !== null} />
        <StepPill label="Invite" active={step === 'invite'} done={state.inviteId !== null} />
      </ol>

      {error && (
        <div role="alert" className="text-sm text-red-700">
          {error}
        </div>
      )}

      {step === 'basics' && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-800">1. Basics</h2>
          <Field label="Display name" required>
            <input
              type="text"
              value={state.name}
              onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="Slug" required hint="lowercase-kebab">
            <input
              type="text"
              value={state.slug}
              onChange={(e) => setState((s) => ({ ...s, slug: e.target.value }))}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
            />
          </Field>
          <Field label="Legal entity name (optional)">
            <input
              type="text"
              value={state.legalEntityName}
              onChange={(e) => setState((s) => ({ ...s, legalEntityName: e.target.value }))}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="First location (optional)">
            <input
              type="text"
              value={state.locationName}
              onChange={(e) => setState((s) => ({ ...s, locationName: e.target.value }))}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="Timezone">
            <input
              type="text"
              value={state.timezone}
              onChange={(e) => setState((s) => ({ ...s, timezone: e.target.value }))}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
            />
          </Field>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={submitBasics}
              disabled={pending || !state.name || !state.slug}
              data-testid="onboard-basics-submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Creating…' : 'Create franchisee'}
            </button>
          </div>
        </div>
      )}

      {step === 'phone' && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-800">2. Twilio phone</h2>
          <Field label="Area code">
            <input
              type="text"
              value={state.areaCode}
              onChange={(e) => setState((s) => ({ ...s, areaCode: e.target.value }))}
              className="w-28 rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
            />
          </Field>
          {state.phoneNumber && (
            <p className="text-sm text-slate-600">
              Provisioned: <span className="font-mono">{state.phoneNumber}</span>
            </p>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => skip('stripe')}
              className="text-sm text-slate-600 hover:underline"
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={provisionPhone}
              disabled={pending}
              data-testid="onboard-phone-submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Provisioning…' : 'Provision number'}
            </button>
          </div>
        </div>
      )}

      {step === 'stripe' && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-800">3. Stripe Connect</h2>
          {state.stripeOnboardingUrl ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-600">
                Hand this link to the franchisee (expires in ~5 min):
              </p>
              <a
                href={state.stripeOnboardingUrl}
                target="_blank"
                rel="noreferrer"
                className="block rounded bg-slate-100 px-3 py-2 text-xs font-mono break-all text-slate-700"
              >
                {state.stripeOnboardingUrl}
              </a>
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              Creates a Stripe account + a single-use onboarding link.
            </p>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => skip('invite')}
              className="text-sm text-slate-600 hover:underline"
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={startStripe}
              disabled={pending}
              data-testid="onboard-stripe-submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Creating…' : state.stripeOnboardingUrl ? 'Re-create link' : 'Create link'}
            </button>
          </div>
        </div>
      )}

      {step === 'invite' && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-800">4. Invite first staff</h2>
          <Field label="Email" required>
            <input
              type="email"
              value={state.firstStaffEmail}
              onChange={(e) =>
                setState((s) => ({ ...s, firstStaffEmail: e.target.value }))
              }
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="Role">
            <select
              value={state.firstStaffRole}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  firstStaffRole: e.target.value as WizardState['firstStaffRole'],
                }))
              }
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="franchisee_owner">Owner</option>
              <option value="location_manager">Location manager</option>
              <option value="dispatcher">Dispatcher</option>
              <option value="tech">Tech</option>
              <option value="csr">CSR</option>
            </select>
          </Field>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => skip('done')}
              className="text-sm text-slate-600 hover:underline"
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={sendInvite}
              disabled={pending || !state.firstStaffEmail}
              data-testid="onboard-invite-submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Sending…' : 'Send invite'}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-2">
          <h2 className="text-sm font-semibold text-green-800">
            All set — franchisee ready.
          </h2>
          <p className="text-sm text-green-700">
            You can revisit any step from /franchisor/franchisees.
          </p>
          <button
            type="button"
            onClick={finish}
            data-testid="onboard-finish"
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            Back to network
          </button>
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
    <li
      className={`px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}
    >
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
