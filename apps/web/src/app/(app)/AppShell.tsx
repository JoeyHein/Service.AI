'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { apiClientFetch } from '../../lib/api.js';
import type { MeResponse } from '../../lib/session.js';

/**
 * The persistent chrome for every authenticated route. Primary day-to-day
 * links sit inline; the corporate-console links are grouped under a
 * "Corporate" dropdown so the bar stays clean. Corporate admins see the
 * corporate hub; branch-scoped users see their day-to-day links.
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

  const scopeLabel = session.scope ? describeScope(session.scope) : 'no membership';

  const isCorporate = session.scope?.type === 'corporate';
  const isTech = session.scope?.type === 'branch' && session.scope.role === 'tech';
  const isBranchScope = session.scope?.type === 'branch';
  const isManager = session.scope?.type === 'branch' && session.scope.role === 'manager';

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14 gap-4">
          <div className="flex items-center gap-1.5">
            <Link href="/dashboard" className="font-semibold text-slate-900 mr-2 shrink-0">
              Service.AI
            </Link>

            {/* Primary, day-to-day links (all roles). */}
            <NavLink href="/customers">Customers</NavLink>
            <NavLink href="/jobs">Jobs</NavLink>
            <Link
              href="/invoices"
              data-testid="nav-invoices"
              className="rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 whitespace-nowrap"
            >
              Invoices
            </Link>
            <NavLink href="/inventory" testId="nav-inventory">Inventory</NavLink>
            <NavLink href="/purchase-orders" testId="nav-purchase-orders">POs</NavLink>
            <NavLink href="/crm/notes" testId="nav-crm">CRM</NavLink>
            <NavLink href="/pricebook">Pricebook</NavLink>

            {/* Branch-scoped, day-to-day ops. */}
            {isBranchScope && <NavLink href="/dispatch">Dispatch</NavLink>}
            {isBranchScope && (
              <NavLink href="/quotes/new" testId="nav-new-quote">New quote</NavLink>
            )}
            {isManager && <NavLink href="/branch" testId="nav-branch">Branch</NavLink>}
            {isBranchScope && (
              <NavLink href="/collections" testId="nav-collections">Collections</NavLink>
            )}
            {isTech && <NavLink href="/tech" testId="nav-tech-view">Tech view</NavLink>}

            {/* Corporate console — grouped to keep the bar uncluttered. */}
            {isCorporate && (
              <NavDropdown label="Corporate">
                <DropItem href="/corporate" testId="nav-corporate">Overview</DropItem>
                <DropItem href="/corporate/branches" testId="nav-corporate-branches">Branches</DropItem>
                <DropItem href="/corporate/managers">Managers</DropItem>
                <DropItem href="/corporate/comp-plans">Comp plans</DropItem>
                <DropItem href="/corporate/pricebook-suggestions">Price requests</DropItem>
                <DropItem href="/corporate/settings/margins" testId="nav-corporate-margins">Margins</DropItem>
              </NavDropdown>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span
              className="text-xs text-slate-600 px-2 py-1 rounded-full border border-slate-200 bg-slate-50 hidden sm:inline"
              data-testid="scope-pill"
            >
              {scopeLabel}
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
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  children,
  testId,
}: {
  href: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 whitespace-nowrap"
    >
      {children}
    </Link>
  );
}

function NavDropdown({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
        data-testid="nav-corporate-menu"
      >
        {label} ▾
      </button>
      {open && (
        <div
          className="absolute left-0 z-20 mt-1 w-44 rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function DropItem({
  href,
  children,
  testId,
}: {
  href: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
    >
      {children}
    </Link>
  );
}

function describeScope(scope: NonNullable<MeResponse['scope']>): string {
  switch (scope.type) {
    case 'corporate':
      return 'Corporate';
    case 'branch':
      return `Branch · ${scope.role}`;
    default:
      return scope.role ?? 'member';
  }
}
