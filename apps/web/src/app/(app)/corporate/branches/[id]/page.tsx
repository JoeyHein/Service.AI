import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../../lib/api.js';
import { BranchStatusControls } from './BranchStatusControls';

interface BranchDetail {
  branch: {
    id: string;
    name: string;
    slug: string;
    status: string;
    timezone: string;
    legalEntityName: string | null;
    phoneNumber: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    countryCode: string | null;
    createdAt: string;
  };
  currentManager: {
    userId: string;
    name: string | null;
    email: string;
    startedAt: string;
  } | null;
  managerHistory: Array<{
    userId: string;
    name: string | null;
    email: string;
    startedAt: string;
    endedAt: string | null;
  }>;
  currentCompPlanAssignment: {
    userId: string;
    compPlanId: string;
    compPlanName: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  } | null;
  recentAuditLog: Array<{
    id: string;
    action: string;
    actorUserId: string | null;
    metadata: unknown;
    createdAt: string;
  }>;
}

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-amber-100 text-amber-800',
  closed: 'bg-slate-200 text-slate-700',
};

export default async function BranchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiServerFetch<BranchDetail>(
    `/api/v1/corporate/branches/${id}`,
  );
  if (res.status === 404 || !res.body.ok || !res.body.data) {
    notFound();
  }
  const detail = res.body.data;

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {detail.branch.name}
          </h1>
          <p className="mt-1 text-sm text-slate-500 font-mono">{detail.branch.slug}</p>
          <p className="mt-2 text-xs text-slate-500">
            {detail.branch.timezone}
            {detail.branch.phoneNumber ? ` · ${detail.branch.phoneNumber}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[detail.branch.status] ?? STATUS_BADGE['closed']}`}
            data-testid="branch-status-badge"
          >
            {detail.branch.status}
          </span>
          <BranchStatusControls
            branchId={detail.branch.id}
            status={detail.branch.status}
          />
        </div>
      </header>

      <Section title="Manager history">
        {detail.managerHistory.length === 0 ? (
          <Empty>No manager has been assigned yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {detail.managerHistory.map((m) => (
              <li
                key={`${m.userId}-${m.startedAt}`}
                className="py-2 flex items-center justify-between"
              >
                <div>
                  <div className="text-slate-800 font-medium">
                    {m.name ?? m.email}
                  </div>
                  <div className="text-xs text-slate-500">{m.email}</div>
                </div>
                <div className="text-xs text-slate-500">
                  {new Date(m.startedAt).toLocaleDateString()} —{' '}
                  {m.endedAt
                    ? new Date(m.endedAt).toLocaleDateString()
                    : 'present'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Comp plan">
        {detail.currentCompPlanAssignment ? (
          <div className="text-sm text-slate-700">
            <p className="font-medium text-slate-900">
              {detail.currentCompPlanAssignment.compPlanName}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Effective from{' '}
              {new Date(
                detail.currentCompPlanAssignment.effectiveFrom,
              ).toLocaleDateString()}
              {detail.currentCompPlanAssignment.effectiveTo
                ? ` to ${new Date(detail.currentCompPlanAssignment.effectiveTo).toLocaleDateString()}`
                : ''}
            </p>
          </div>
        ) : (
          <Empty>No active comp plan assignment.</Empty>
        )}
      </Section>

      <Section title="Recent activity">
        {detail.recentAuditLog.length === 0 ? (
          <Empty>No audit entries yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {detail.recentAuditLog.map((row) => (
              <li key={row.id} className="py-2 flex items-center justify-between">
                <div>
                  <div className="text-slate-800 font-medium">{row.action}</div>
                  <div className="text-xs text-slate-500">
                    {row.actorUserId ?? 'system'}
                  </div>
                </div>
                <time className="text-xs text-slate-500">
                  {new Date(row.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-medium text-slate-900 uppercase tracking-wide mb-3">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-slate-500 py-2">{children}</div>;
}
