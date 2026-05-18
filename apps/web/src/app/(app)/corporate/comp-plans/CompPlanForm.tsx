'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiClientFetch } from '../../../../lib/api.js';

interface FieldError {
  path: string;
  message: string;
}

interface InitialPlan {
  id: string;
  name: string;
  kind: 'base_plus_commission' | 'commission_only';
  baseSalaryCents: number;
  payPeriod: 'monthly' | 'biweekly';
  commissionRules: unknown[];
  effectiveFrom: string; // ISO timestamp
  effectiveTo: string | null;
}

/**
 * Inline editor for a comp plan. commission_rules is a JSON textarea —
 * we run a local JSON.parse before POSTing so a syntax error never
 * makes it to the API and so we can surface bad JSON as its own
 * field-level error.
 */
export function CompPlanForm({
  mode,
  initial,
}: {
  mode: 'create' | 'edit';
  initial?: InitialPlan;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<'base_plus_commission' | 'commission_only'>(
    initial?.kind ?? 'base_plus_commission',
  );
  const [baseSalaryCents, setBaseSalaryCents] = useState<number>(
    initial?.baseSalaryCents ?? 0,
  );
  const [payPeriod, setPayPeriod] = useState<'monthly' | 'biweekly'>(
    initial?.payPeriod ?? 'monthly',
  );
  const [rulesText, setRulesText] = useState(
    JSON.stringify(
      initial?.commissionRules ?? [
        { kind: 'flat_percent_of_invoice_paid', percent: 5 },
      ],
      null,
      2,
    ),
  );
  const [effectiveFrom, setEffectiveFrom] = useState(
    initial?.effectiveFrom
      ? initial.effectiveFrom.slice(0, 10)
      : new Date().toISOString().slice(0, 10),
  );
  const [effectiveTo, setEffectiveTo] = useState(
    initial?.effectiveTo ? initial.effectiveTo.slice(0, 10) : '',
  );
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [topError, setTopError] = useState<string | null>(null);

  function fieldError(path: string): string | undefined {
    return errors.find((e) => e.path === path)?.message;
  }

  function submit() {
    setErrors([]);
    setTopError(null);

    let parsedRules: unknown;
    try {
      parsedRules = JSON.parse(rulesText);
    } catch (err) {
      setErrors([
        {
          path: 'commissionRules',
          message: err instanceof Error ? err.message : 'Invalid JSON',
        },
      ]);
      return;
    }

    const payload = {
      name,
      kind,
      baseSalaryCents,
      payPeriod,
      commissionRules: parsedRules,
      effectiveFrom,
      effectiveTo: effectiveTo || null,
    };

    startTransition(async () => {
      const url =
        mode === 'create'
          ? '/api/v1/corporate/comp-plans'
          : `/api/v1/corporate/comp-plans/${initial!.id}`;
      const res = await apiClientFetch<{ id: string }>(url, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        body: JSON.stringify(payload),
      });
      if (res.status === 400 && res.body.error) {
        const e = res.body.error as {
          code: string;
          message: string;
          details?: FieldError[];
        };
        if (Array.isArray(e.details) && e.details.length > 0) {
          setErrors(e.details);
        }
        setTopError(e.message);
        return;
      }
      if (
        (mode === 'create' && res.status !== 201) ||
        (mode === 'edit' && res.status !== 200) ||
        !res.body.data
      ) {
        setTopError(res.body.error?.message ?? 'Save failed');
        return;
      }
      const id = res.body.data.id;
      router.push(`/corporate/comp-plans/${id}`);
      router.refresh();
    });
  }

  return (
    <div className="mt-6 max-w-3xl space-y-4" data-testid="comp-plan-form">
      {topError && (
        <div role="alert" className="text-sm text-red-700">
          {topError}
        </div>
      )}

      <Field label="Name" required error={fieldError('name')}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Kind" required error={fieldError('kind')}>
          <select
            value={kind}
            onChange={(e) =>
              setKind(e.target.value as 'base_plus_commission' | 'commission_only')
            }
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="base_plus_commission">Base + commission</option>
            <option value="commission_only">Commission only</option>
          </select>
        </Field>
        <Field label="Pay period" required error={fieldError('payPeriod')}>
          <select
            value={payPeriod}
            onChange={(e) =>
              setPayPeriod(e.target.value as 'monthly' | 'biweekly')
            }
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="monthly">Monthly</option>
            <option value="biweekly">Bi-weekly</option>
          </select>
        </Field>
      </div>

      <Field
        label="Base salary (cents)"
        required
        error={fieldError('baseSalaryCents')}
      >
        <input
          type="number"
          min={0}
          step={1}
          value={baseSalaryCents}
          onChange={(e) => setBaseSalaryCents(parseInt(e.target.value, 10) || 0)}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Effective from"
          required
          error={fieldError('effectiveFrom')}
        >
          <input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Effective to (optional)" error={fieldError('effectiveTo')}>
          <input
            type="date"
            value={effectiveTo}
            onChange={(e) => setEffectiveTo(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </Field>
      </div>

      <Field
        label="Commission rules (JSON array)"
        error={fieldError('commissionRules')}
      >
        <textarea
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          rows={10}
          data-testid="comp-plan-rules"
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs font-mono"
        />
      </Field>

      {errors.length > 0 && (
        <ul className="text-xs text-red-700 list-disc pl-4 space-y-0.5">
          {errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono">{e.path}</span>: {e.message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={pending || !name}
          data-testid="comp-plan-submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Saving…' : mode === 'create' ? 'Create plan' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="text-slate-700 font-medium">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      <div className="mt-1">{children}</div>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </label>
  );
}
