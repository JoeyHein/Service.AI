import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { getSession } from '../../../../lib/session.js';
import { AcceptInviteForm } from './AcceptInviteForm';

interface InviteMetadata {
  email: string;
  role: string;
  scopeType: 'franchisor' | 'franchisee' | 'location';
  expiresAt: string;
}

interface ErrorBody {
  code: string;
  message: string;
}

async function fetchInvite(token: string): Promise<
  | { ok: true; data: InviteMetadata }
  | { ok: false; status: number; error: ErrorBody | null }
> {
  const res = await apiServerFetch<InviteMetadata>(
    `/api/v1/invites/accept/${encodeURIComponent(token)}`,
  );
  if (res.status === 200 && res.body.ok && res.body.data) {
    return { ok: true, data: res.body.data };
  }
  return { ok: false, status: res.status, error: res.body.error ?? null };
}

function friendlyInviteError(status: number, error: ErrorBody | null): string {
  switch (error?.code) {
    case 'INVITE_EXPIRED':
      return 'This invite has expired. Ask the person who sent it to send you a new one.';
    case 'INVITE_REVOKED':
      return 'This invite was revoked.';
    case 'INVITE_USED':
      return 'This invite has already been redeemed. Sign in to access your account.';
    case 'NOT_FOUND':
      return 'We could not find that invite. Double-check the link.';
    default:
      return `Something went wrong loading this invite (status ${status}).`;
  }
}

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await fetchInvite(token);

  if (!invite.ok) {
    return (
      <>
        <h2 className="text-xl font-semibold text-slate-900 mb-1">
          Invite unavailable
        </h2>
        <p className="text-sm text-slate-600 mb-6">
          {friendlyInviteError(invite.status, invite.error)}
        </p>
        <Link
          href="/signin"
          className="inline-block w-full text-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Go to sign in
        </Link>
      </>
    );
  }

  const session = await getSession();
  const nextPath = `/accept-invite/${token}`;
  const emailMatches =
    session !== null &&
    // The /me endpoint does not return email today. When it's added we can
    // compare here; until then, if the invitee has ANY session we let them
    // proceed and the server's POST /accept will enforce the email match.
    true;

  if (!session) {
    return (
      <>
        <h2 className="text-xl font-semibold text-slate-900 mb-1">
          You&apos;re invited
        </h2>
        <p className="text-sm text-slate-600 mb-6">
          You&apos;ve been invited to join Service.AI as{' '}
          <strong className="text-slate-900">{invite.data.role}</strong>. Sign
          in or create an account with <strong>{invite.data.email}</strong> to
          accept.
        </p>
        <div className="space-y-3">
          <Link
            href={`/signin?email=${encodeURIComponent(invite.data.email)}&next=${encodeURIComponent(nextPath)}`}
            className="block w-full text-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Sign in
          </Link>
          <Link
            href={`/signup?email=${encodeURIComponent(invite.data.email)}&next=${encodeURIComponent(nextPath)}`}
            className="block w-full text-center rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Create account
          </Link>
        </div>
      </>
    );
  }

  if (!emailMatches) {
    return (
      <>
        <h2 className="text-xl font-semibold text-slate-900 mb-1">
          Signed in as someone else
        </h2>
        <p className="text-sm text-slate-600 mb-6">
          This invite is for{' '}
          <strong className="text-slate-900">{invite.data.email}</strong>. Sign
          out first, then sign in with that email to accept.
        </p>
        <Link
          href="/signin"
          className="inline-block w-full text-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Go to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <h2 className="text-xl font-semibold text-slate-900 mb-1">Accept invite</h2>
      <p className="text-sm text-slate-600 mb-6">
        You&apos;re about to join as{' '}
        <strong className="text-slate-900">{invite.data.role}</strong>. Click
        below to confirm.
      </p>
      <AcceptInviteForm token={token} />
    </>
  );
}
