'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';
import { apiClientFetch } from '../../lib/api.js';
import type { MeResponse } from '../../lib/session.js';

/**
 * The persistent chrome for every authenticated route. Displays the
 * user's resolved scope in the header and exposes the sign-out button.
 *
 * Post-CHR-06: the franchisor / impersonation chrome (HqBanner, "View as"
 * links) is gone. Corporate admins see the corporate hub nav; branch-
 * scoped users see their day-to-day links.
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

  const isCorporate = session.scope?.type === 'corporate';
  const isTech =
    session.scope?.type === 'branch' && session.scope.role === 'tech';
  const isBranchScope = session.scope?.type === 'branch';
  const isManager =
    session.scope?.type === 'branch' && session.scope.role === 'manager';

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="font-semibold text-slate-900">
              Service.AI
            </Link>
            <span
              className="text-xs text-slate-500 px-2 py-0.5 rounded border border-slate-200 bg-slate-50"
              data-testid="scope-pill"
            >
              {scopeLabel}
            </span>
            <Link
              href="/customers"
              className="text-sm text-blue-700 hover:underline"
            >
              Customers
            </Link>
            <Link
              href="/jobs"
              className="text-sm text-blue-700 hover:underline"
            >
              Jobs
            </Link>
            <Link
              href="/invoices"
              className="text-sm text-blue-700 hover:underline"
              data-testid="nav-invoices"
            >
              Invoices
            </Link>
            <Link
              href="/crm/notes"
              className="text-sm text-blue-700 hover:underline"
              data-testid="nav-crm"
            >
              CRM Inbox
            </Link>
            <Link
              href="/inventory"
              className="text-sm text-blue-700 hover:underline"
              data-testid="nav-inventory"
            >
              Inventory
            </Link>
            {isManager && (
              <Link
                href="/branch"
                className="text-sm text-blue-700 hover:underline"
                data-testid="nav-branch"
              >
                Branch
              </Link>
            )}
            {isBranchScope && (
              <Link
                href="/dispatch"
                className="text-sm text-blue-700 hover:underline"
              >
                Dispatch
              </Link>
            )}
            {isBranchScope && (
              <Link
                href="/quotes/new"
                className="text-sm text-blue-700 hover:underline"
                data-testid="nav-new-quote"
              >
                New quote
              </Link>
            )}
            {isCorporate && (
              <Link
                href="/corporate"
                className="text-sm text-blue-700 hover:underline"
                data-testid="nav-corporate"
              >
                Corporate
              </Link>
            )}
            {isCorporate && (
              <Link
                href="/corporate/branches"
                className="text-sm text-blue-700 hover:underline"
                data-testid="nav-corporate-branches"
              >
                Branches
              </Link>
            )}
            {isCorporate && (
              <Link
                href="/corporate/managers"
                className="text-sm text-blue-700 hover:underline"
              >
                Managers
              </Link>
            )}
            {isCorporate && (
              <Link
                href="/corporate/comp-plans"
                className="text-sm text-blue-700 hover:underline"
              >
                Comp plans
              </Link>
            )}
            {isCorporate && (
              <Link
                href="/corporate/pricebook-suggestions"
                className="text-sm text-blue-700 hover:underline"
              >
                Price requests
              </Link>
            )}
            {isCorporate && (
              <Link
                href="/corporate/settings/margins"
                className="text-sm text-blue-700 hover:underline"
                data-testid="nav-corporate-margins"
              >
                Margins
              </Link>
            )}
            <Link
              href="/pricebook"
              className="text-sm text-blue-700 hover:underline"
            >
              Pricebook
            </Link>
            {isTech && (
              <Link
                href="/tech"
                className="text-sm text-blue-700 hover:underline"
                data-testid="nav-tech-view"
              >
                Tech view
              </Link>
            )}
            {isBranchScope && (
              <Link
                href="/collections"
                className="text-sm text-blue-700 hover:underline"
                data-testid="nav-collections"
              >
                Collections
              </Link>
            )}
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
    case 'corporate':
      return `Corporate admin · ${scope.role}`;
    case 'branch':
      return `Branch · ${scope.role}`;
    default:
      return scope.role ?? 'member';
  }
}
