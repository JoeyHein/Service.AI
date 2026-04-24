'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';
import { apiClientFetch } from '../../lib/api.js';
import type { MeResponse } from '../../lib/session.js';
import { OfflineQueueDrainer } from './OfflineQueueDrainer';
import { PushSubscribe } from './PushSubscribe';

/**
 * Minimal chrome for the tech PWA. Full-bleed layout, 16px side
 * padding, single "home" link back to today's list.
 */
export function TechShell({
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

  return (
    <div className="min-h-screen bg-slate-50">
      <OfflineQueueDrainer />
      <PushSubscribe />
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="mx-auto max-w-3xl px-4 flex items-center justify-between h-12">
          <Link
            href="/tech"
            className="font-semibold text-slate-900 text-sm"
            data-testid="tech-home"
          >
            Service.AI · Tech
          </Link>
          <button
            type="button"
            onClick={signOut}
            disabled={pending}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-4" data-user-id={session.user.id}>
        {children}
      </main>
    </div>
  );
}
