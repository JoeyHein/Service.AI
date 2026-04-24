'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiClientFetch } from '../../../../../../lib/api.js';

type RuleType = 'percentage' | 'flat_per_job' | 'tiered' | 'minimum_floor';

export interface AgreementPayload {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'ended';
  rules: Array<{
    id: string;
    ruleType: RuleType;
    params: unknown;
    sortOrder: number;
  }>;
}

interface EditorRule {
  ruleType: RuleType;
  params: unknown;
}

const BLANK: Record<RuleType, unknown> = {
  percentage: { basisPoints: 500 },
  flat_per_job: { amountCents: 2500 },
  tiered: { tiers: [{ upToCents: 1000000, basisPoints: 1000 }, { upToCents: null, basisPoints: 500 }] },
  minimum_floor: { perMonthCents: 50000 },
};

function toApiRules(edits: EditorRule[]) {
  return edits.map((e) => ({ type: e.ruleType, params: e.params }));
}

/**
 * Minimal rules editor — the active agreement is read-only, a
 * draft can be edited and activated. Rule shapes are free-form
 * JSON textarea per rule for v1; a typed input form per rule
 * type ships when the pricebook UX pattern from phase 4 is
 * generalised.
 */
export function AgreementEditor({
  franchiseeId,
  initial,
}: {
  franchiseeId: string;
  initial: AgreementPayload | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? 'Draft agreement');
  const [rules, setRules] = useState<EditorRule[]>(
    (initial?.rules ?? []).map((r) => ({ ruleType: r.ruleType, params: r.params })),
  );

  const isActive = initial?.status === 'active';
  const hasDraft = initial?.status === 'draft';

  function addRule() {
    setRules((prev) => [...prev, { ruleType: 'percentage', params: BLANK.percentage }]);
  }

  function removeRule(idx: number) {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateRule(idx: number, patch: Partial<EditorRule>) {
    setRules((prev) =>
      prev.map((r, i) =>
        i === idx
          ? { ...r, ...patch, params: patch.ruleType ? BLANK[patch.ruleType] : (patch.params ?? r.params) }
          : r,
      ),
    );
  }

  function updateParams(idx: number, jsonText: string) {
    try {
      const parsed = JSON.parse(jsonText);
      updateRule(idx, { params: parsed });
      setError(null);
    } catch {
      setError(`Rule ${idx + 1}: invalid JSON`);
    }
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      if (isActive || !initial) {
        // Create a new draft.
        const res = await apiClientFetch<AgreementPayload>(
          `/api/v1/franchisees/${franchiseeId}/agreement`,
          {
            method: 'POST',
            body: JSON.stringify({ name, rules: toApiRules(rules) }),
          },
        );
        if (res.status !== 201) {
          setError(res.body.error?.message ?? 'Save failed');
          return;
        }
        router.refresh();
        return;
      }
      // Patch existing draft.
      const res = await apiClientFetch<AgreementPayload>(
        `/api/v1/franchisees/${franchiseeId}/agreement/${initial.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ name, rules: toApiRules(rules) }),
        },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Save failed');
        return;
      }
      router.refresh();
    });
  }

  function activate() {
    if (!hasDraft || !initial) return;
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/franchisees/${franchiseeId}/agreement/${initial.id}/activate`,
        { method: 'POST', body: '{}' },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Activate failed');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <label className="block text-sm font-medium text-slate-700" htmlFor="agrName">
          Name
        </label>
        <input
          id="agrName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isActive}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />
        <p className="mt-1 text-xs text-slate-500">
          Status: <span className="font-mono">{initial?.status ?? 'none'}</span>
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-slate-700">Rules</h2>
          {!isActive && (
            <button
              type="button"
              onClick={addRule}
              className="text-sm text-blue-700 hover:underline"
              data-testid="add-rule"
            >
              + Add rule
            </button>
          )}
        </div>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {rules.length === 0 ? (
            <li className="py-3 text-slate-500">No rules yet.</li>
          ) : (
            rules.map((r, idx) => (
              <li key={idx} className="py-3 space-y-2">
                <div className="flex gap-2 items-center">
                  <select
                    value={r.ruleType}
                    onChange={(e) =>
                      updateRule(idx, { ruleType: e.target.value as RuleType })
                    }
                    disabled={isActive}
                    className="rounded border border-slate-300 px-2 py-1 text-sm"
                  >
                    <option value="percentage">Percentage (bps)</option>
                    <option value="flat_per_job">Flat per job (cents)</option>
                    <option value="tiered">Tiered (bps per bracket)</option>
                    <option value="minimum_floor">Minimum floor (cents/month)</option>
                  </select>
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => removeRule(idx)}
                      className="text-xs text-red-700 hover:underline"
                    >
                      remove
                    </button>
                  )}
                </div>
                <textarea
                  rows={4}
                  defaultValue={JSON.stringify(r.params, null, 2)}
                  onBlur={(e) => updateParams(idx, e.target.value)}
                  disabled={isActive}
                  className="w-full rounded border border-slate-300 font-mono text-xs p-2"
                />
              </li>
            ))
          )}
        </ul>
      </div>

      {error && (
        <div role="alert" className="text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        {hasDraft && (
          <button
            type="button"
            onClick={activate}
            disabled={pending}
            data-testid="activate-agreement"
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Activate this draft
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={pending || isActive}
          data-testid="save-agreement"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {pending ? 'Saving…' : isActive ? 'Create new draft instead' : initial ? 'Save draft' : 'Create draft'}
        </button>
      </div>
    </div>
  );
}
