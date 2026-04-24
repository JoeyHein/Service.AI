'use client';

import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../../../lib/api.js';

interface ConnectStatus {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/**
 * Kicks off a Stripe Connect onboarding session. Because account
 * links expire in ~5 minutes, we always call POST /connect/onboard
 * fresh when the button is clicked instead of caching a URL.
 */
export function ConnectOnboardingPanel({
  franchiseeId,
  status,
}: {
  franchiseeId: string;
  status: ConnectStatus | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ready = status?.chargesEnabled && status?.payoutsEnabled;
  const hasAccount = Boolean(status?.accountId);
  const label = ready
    ? 'Re-onboard'
    : hasAccount
      ? 'Resume onboarding'
      : 'Start Stripe onboarding';

  function go() {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<{ onboardingUrl: string }>(
        `/api/v1/franchisees/${franchiseeId}/connect/onboard`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (res.status !== 200 || !res.body.data) {
        setError(res.body.error?.message ?? 'Could not start onboarding');
        return;
      }
      window.location.assign(res.body.data.onboardingUrl);
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-medium text-slate-700">Onboarding</h2>
      <p className="mt-1 text-sm text-slate-500">
        Click to open a Stripe-hosted onboarding flow. The link
        expires in a few minutes so always click fresh.
      </p>
      <button
        type="button"
        onClick={go}
        disabled={pending}
        data-testid="connect-onboard-button"
        className="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? 'Preparing…' : label}
      </button>
      {error && (
        <div role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
