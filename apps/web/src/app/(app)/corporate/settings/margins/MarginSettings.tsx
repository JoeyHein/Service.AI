'use client';

import { useState } from 'react';
import { apiClientFetch } from '../../../../../lib/api.js';

export interface MarginOverride {
  id: string;
  itemCategory: string;
  marginPct: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarginsData {
  defaultPct: number;
  minPct: number;
  maxPct: number;
  overrides: MarginOverride[];
}

/**
 * Editor for the corporate margin policy.
 *
 * The default margin sits at the top, category overrides live in the
 * middle, and the min/max bounds collapse at the bottom. All writes go
 * through `apiClientFetch`; after every successful write the editor
 * refetches `/api/v1/corporate/margins` so stale data never lingers.
 *
 * Spec note: per the SQB-08 gate, min/max are conceptually
 * platform_admin-only. In the corporate hub model there is no
 * platform_admin role any more, so corporate_admin can edit them.
 * TODO(SQB-roles): re-split when a role above corporate_admin exists.
 */
export function MarginSettings({ initial }: { initial: MarginsData }) {
  const [data, setData] = useState<MarginsData>(initial);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [defaultPctInput, setDefaultPctInput] = useState<string>(
    String(initial.defaultPct),
  );
  const [minPctInput, setMinPctInput] = useState<string>(String(initial.minPct));
  const [maxPctInput, setMaxPctInput] = useState<string>(String(initial.maxPct));
  const [boundsOpen, setBoundsOpen] = useState(false);

  async function refresh(): Promise<void> {
    const res = await apiClientFetch<MarginsData>('/api/v1/corporate/margins');
    if (res.status === 200 && res.body.ok && res.body.data) {
      setData(res.body.data);
      setDefaultPctInput(String(res.body.data.defaultPct));
      setMinPctInput(String(res.body.data.minPct));
      setMaxPctInput(String(res.body.data.maxPct));
    }
  }

  async function saveDefault(): Promise<void> {
    setPolicyError(null);
    const value = Number(defaultPctInput);
    if (!Number.isFinite(value)) {
      setPolicyError('Default margin must be a number');
      return;
    }
    setSavingPolicy(true);
    const res = await apiClientFetch<MarginsData>(
      '/api/v1/corporate/margins/policy',
      {
        method: 'PATCH',
        body: JSON.stringify({ defaultPct: value }),
      },
    );
    setSavingPolicy(false);
    if (res.status !== 200 || !res.body.ok) {
      setPolicyError(res.body.error?.message ?? 'Save failed');
      return;
    }
    await refresh();
  }

  async function saveBounds(): Promise<void> {
    setPolicyError(null);
    const min = Number(minPctInput);
    const max = Number(maxPctInput);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      setPolicyError('Min and max must be numbers');
      return;
    }
    setSavingPolicy(true);
    const res = await apiClientFetch<MarginsData>(
      '/api/v1/corporate/margins/policy',
      {
        method: 'PATCH',
        body: JSON.stringify({ minPct: min, maxPct: max }),
      },
    );
    setSavingPolicy(false);
    if (res.status !== 200 || !res.body.ok) {
      setPolicyError(res.body.error?.message ?? 'Save failed');
      return;
    }
    await refresh();
  }

  return (
    <div className="space-y-8" data-testid="margin-settings">
      <DefaultSection
        defaultPctInput={defaultPctInput}
        setDefaultPctInput={setDefaultPctInput}
        savingPolicy={savingPolicy}
        policyError={policyError}
        onSave={saveDefault}
      />

      <OverridesSection overrides={data.overrides} onChange={refresh} />

      <BoundsSection
        open={boundsOpen}
        toggle={() => setBoundsOpen((o) => !o)}
        minPctInput={minPctInput}
        setMinPctInput={setMinPctInput}
        maxPctInput={maxPctInput}
        setMaxPctInput={setMaxPctInput}
        savingPolicy={savingPolicy}
        onSave={saveBounds}
      />
    </div>
  );
}

function DefaultSection({
  defaultPctInput,
  setDefaultPctInput,
  savingPolicy,
  policyError,
  onSave,
}: {
  defaultPctInput: string;
  setDefaultPctInput: (v: string) => void;
  savingPolicy: boolean;
  policyError: string | null;
  onSave: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-medium text-slate-900">Default margin</h2>
      <p className="mt-1 text-sm text-slate-500">
        Applied to every line item that has no category override and no
        per-line manager override.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <label className="text-sm text-slate-700" htmlFor="default-pct">
          Default %
        </label>
        <input
          id="default-pct"
          type="number"
          step="0.01"
          value={defaultPctInput}
          onChange={(e) => setDefaultPctInput(e.target.value)}
          className="w-32 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          data-testid="default-pct-input"
        />
        <button
          type="button"
          onClick={onSave}
          disabled={savingPolicy}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="save-default-pct"
        >
          {savingPolicy ? 'Saving...' : 'Save'}
        </button>
      </div>
      {policyError && (
        <p className="mt-2 text-sm text-rose-600" data-testid="policy-error">
          {policyError}
        </p>
      )}
    </div>
  );
}

function OverridesSection({
  overrides,
  onChange,
}: {
  overrides: MarginOverride[];
  onChange: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [newPct, setNewPct] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function addOverride(): Promise<void> {
    setAddError(null);
    const pct = Number(newPct);
    if (!newCategory.trim() || !Number.isFinite(pct)) {
      setAddError('Category and margin% are required');
      return;
    }
    setWorking(true);
    const res = await apiClientFetch('/api/v1/corporate/margin-overrides', {
      method: 'POST',
      body: JSON.stringify({
        itemCategory: newCategory.trim(),
        marginPct: pct,
      }),
    });
    setWorking(false);
    if (res.status !== 201 || !res.body.ok) {
      setAddError(res.body.error?.message ?? 'Create failed');
      return;
    }
    setNewCategory('');
    setNewPct('');
    setAdding(false);
    await onChange();
  }

  async function patchOverride(id: string, marginPct: number): Promise<void> {
    setWorking(true);
    await apiClientFetch(`/api/v1/corporate/margin-overrides/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ marginPct }),
    });
    setWorking(false);
    await onChange();
  }

  async function deleteOverride(id: string): Promise<void> {
    setWorking(true);
    await apiClientFetch(`/api/v1/corporate/margin-overrides/${id}`, {
      method: 'DELETE',
    });
    setWorking(false);
    await onChange();
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-slate-900">
          Category overrides
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            data-testid="add-override-toggle"
          >
            Add override
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Pin a different margin for a specific item category (e.g. springs,
        rails, hardware).
      </p>

      <div
        className="mt-4 overflow-hidden rounded-md border border-slate-200"
        data-testid="overrides-table"
      >
        <table className="min-w-full text-sm divide-y divide-slate-200">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Margin %</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {overrides.length === 0 && !adding ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-6 text-center text-slate-500"
                >
                  No category overrides yet.
                </td>
              </tr>
            ) : (
              overrides.map((o) => (
                <OverrideRow
                  key={o.id}
                  override={o}
                  working={working}
                  onSave={(pct) => patchOverride(o.id, pct)}
                  onDelete={() => deleteOverride(o.id)}
                />
              ))
            )}
            {adding && (
              <tr>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="item category"
                    className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                    data-testid="new-override-category"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.01"
                    value={newPct}
                    onChange={(e) => setNewPct(e.target.value)}
                    placeholder="margin %"
                    className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
                    data-testid="new-override-pct"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={addOverride}
                    disabled={working}
                    className="mr-2 rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    data-testid="save-new-override"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      setNewCategory('');
                      setNewPct('');
                      setAddError(null);
                    }}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {addError && (
        <p className="mt-2 text-sm text-rose-600" data-testid="override-error">
          {addError}
        </p>
      )}
    </div>
  );
}

function OverrideRow({
  override,
  working,
  onSave,
  onDelete,
}: {
  override: MarginOverride;
  working: boolean;
  onSave: (pct: number) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [pct, setPct] = useState<string>(String(override.marginPct));
  const [editing, setEditing] = useState(false);

  return (
    <tr>
      <td className="px-3 py-2 text-slate-900">{override.itemCategory}</td>
      <td className="px-3 py-2">
        {editing ? (
          <input
            type="number"
            step="0.01"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        ) : (
          <span className="text-slate-700">{override.marginPct}%</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {editing ? (
          <>
            <button
              type="button"
              disabled={working}
              onClick={async () => {
                const n = Number(pct);
                if (Number.isFinite(n)) {
                  await onSave(n);
                  setEditing(false);
                }
              }}
              className="mr-2 rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setPct(String(override.marginPct));
                setEditing(false);
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="mr-2 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
              data-testid={`edit-override-${override.id}`}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => {
                void onDelete();
              }}
              className="rounded-md border border-rose-300 bg-white px-3 py-1 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              data-testid={`delete-override-${override.id}`}
            >
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

function BoundsSection({
  open,
  toggle,
  minPctInput,
  setMinPctInput,
  maxPctInput,
  setMaxPctInput,
  savingPolicy,
  onSave,
}: {
  open: boolean;
  toggle: () => void;
  minPctInput: string;
  setMinPctInput: (v: string) => void;
  maxPctInput: string;
  setMaxPctInput: (v: string) => void;
  savingPolicy: boolean;
  onSave: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between text-left"
        data-testid="bounds-toggle"
      >
        <span>
          <span className="text-lg font-medium text-slate-900">
            Bounds (advanced)
          </span>
          <span className="ml-2 text-xs text-slate-500">
            min / max margin guardrails
          </span>
        </span>
        <span className="text-sm text-slate-500">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-3" data-testid="bounds-panel">
          <p className="text-sm text-amber-700">
            Heads up: bounds enforce the corporate floor and ceiling on every
            margin override. Editing them affects every branch and every
            future quote.
          </p>
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-700" htmlFor="min-pct">
              Min %
            </label>
            <input
              id="min-pct"
              type="number"
              step="0.01"
              value={minPctInput}
              onChange={(e) => setMinPctInput(e.target.value)}
              className="w-32 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              data-testid="min-pct-input"
            />
            <label className="text-sm text-slate-700" htmlFor="max-pct">
              Max %
            </label>
            <input
              id="max-pct"
              type="number"
              step="0.01"
              value={maxPctInput}
              onChange={(e) => setMaxPctInput(e.target.value)}
              className="w-32 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              data-testid="max-pct-input"
            />
            <button
              type="button"
              onClick={onSave}
              disabled={savingPolicy}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="save-bounds"
            >
              Save bounds
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
