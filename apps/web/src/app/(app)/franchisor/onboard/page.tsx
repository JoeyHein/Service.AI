import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '../../../../lib/session.js';
import { OnboardWizard } from './OnboardWizard';

export default async function OnboardPage() {
  const session = await getSession();
  if (
    !session ||
    (session.scope?.type !== 'platform' && session.scope?.type !== 'franchisor')
  ) {
    notFound();
  }
  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            Onboard a franchisee
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Walk through each step — the wizard remembers progress in your browser.
          </p>
        </div>
        <Link
          href="/franchisor"
          className="text-sm text-slate-600 hover:underline"
        >
          ← Network
        </Link>
      </div>
      <OnboardWizard />
    </section>
  );
}
