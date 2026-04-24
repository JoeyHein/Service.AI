'use client';

import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../../lib/api.js';

interface NotesResult {
  conversationId: string;
  description: string;
  intent: string;
  warnings: string[];
}

/**
 * Tech PWA component. Turns rough repair notes into a polished
 * customer-facing description. Results land in a read-only
 * textarea the tech can copy into the invoice notes field +
 * approve/override via the feedback endpoint.
 */
export function NotesToInvoicePanel({ jobId }: { jobId: string }) {
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<NotesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    if (!notes.trim()) {
      setError('Add a few notes first');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<NotesResult>(
        `/api/v1/jobs/${jobId}/notes-to-invoice`,
        { method: 'POST', body: JSON.stringify({ notes }) },
      );
      if (res.status !== 200 || !res.body.data) {
        setError(res.body.error?.message ?? 'Draft failed');
        return;
      }
      setResult(res.body.data);
    });
  }

  function feedback(kind: 'accept' | 'override') {
    if (!result) return;
    void apiClientFetch('/api/v1/ai/feedback', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: result.conversationId,
        kind,
        subjectKind: 'notes_invoice_draft',
        subjectRef: { description: result.description.slice(0, 120) },
      }),
    });
  }

  return (
    <section
      data-testid="notes-to-invoice-panel"
      className="mt-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-800">Draft from notes</h2>
      <p className="mt-1 text-xs text-slate-500">
        Dictate or type rough notes — AI writes a clean invoice description.
      </p>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Replaced 2 torsion springs, lubed rollers, tested 3 cycles."
        rows={3}
        className="mt-3 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        data-testid="notes-input"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={run}
          disabled={pending}
          data-testid="notes-submit"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Drafting…' : 'Draft'}
        </button>
      </div>
      {error && (
        <div role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {result && (
        <div className="mt-4 space-y-2">
          <textarea
            readOnly
            value={result.description}
            rows={3}
            className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
            data-testid="notes-output"
          />
          {result.warnings.length > 0 && (
            <ul className="text-xs text-amber-700 list-disc pl-4">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => feedback('accept')}
              data-testid="notes-accept"
              className="rounded-md bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => feedback('override')}
              data-testid="notes-override"
              className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Override
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
