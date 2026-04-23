'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function accept() {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/invites/accept/${encodeURIComponent(token)}`,
        { method: 'POST' },
      );
      if (res.status !== 200) {
        const msg = res.body.error?.message;
        if (res.body.error?.code === 'EMAIL_MISMATCH') {
          setError(
            'Your signed-in email does not match the invite. Sign out and sign back in with the invited email.',
          );
        } else {
          setError(msg ?? 'Could not accept invite. Try again later.');
        }
        return;
      }
      router.push('/dashboard');
      router.refresh();
    });
  }

  return (
    <>
      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 mb-4"
        >
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={accept}
        disabled={pending}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
      >
        {pending ? 'Accepting…' : 'Accept invite'}
      </button>
    </>
  );
}
