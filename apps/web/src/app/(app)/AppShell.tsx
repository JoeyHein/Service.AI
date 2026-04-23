'use client';

import { useRouter } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';
import { apiClientFetch } from '../../lib/api.js';
import type { MeResponse } from '../../lib/session.js';

/**
 * The persistent chrome for every authenticated route. Displays the
 * user's resolved scope in the header and exposes the sign-out button.
 */
export function AppShell({
  session,
  children,
}: {
  session: MeResponse;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function signOut() {
    startTransition(async () => {
      await apiClientFetch('/api/auth/sign-out', { method: 'POST' });
      router.push('/signin');
      router.refresh();
    });
  }

  const scopeLabel = session.scope
    ? describeScope(session.scope)
    : 'no active membership';

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-slate-900">Service.AI</span>
            <span
              className="text-xs text-slate-500 px-2 py-0.5 rounded border border-slate-200 bg-slate-50"
              data-testid="scope-pill"
            >
              {scopeLabel}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="text-sm text-slate-600 hidden sm:inline"
              data-testid="user-id"
            >
              {session.user.id}
            </span>
            <button
              type="button"
              onClick={signOut}
              disabled={pending}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {pending ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}

function describeScope(scope: NonNullable<MeResponse['scope']>): string {
  switch (scope.type) {
    case 'platform':
      return 'Platform admin';
    case 'franchisor':
      return `Franchisor admin · ${scope.role}`;
    case 'franchisee':
      return `Franchisee · ${scope.role}`;
    default:
      return scope.role ?? 'member';
  }
}
