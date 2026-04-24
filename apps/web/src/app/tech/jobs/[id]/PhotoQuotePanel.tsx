'use client';

import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

interface Candidate {
  serviceItemId: string;
  sku: string;
  name: string;
  unitPriceDollars: string;
  confidence: number;
  reasoning: string;
  requiresConfirmation: boolean;
  supportingSources: string[];
}

interface PhotoQuoteResult {
  conversationId: string;
  vision: {
    make: string | null;
    model: string | null;
    failureMode: string | null;
    confidence: number;
  };
  candidates: Candidate[];
}

/**
 * Tech PWA component. Lets the tech tap "Photo quote" — the
 * button opens the device camera via the same <input
 * capture="environment" /> hook as TM-04, uploads the photo
 * to the existing presigned-URL flow, then POSTs to
 * /jobs/:id/photo-quote. Results render inline with one-tap
 * Accept / Override buttons that fire into the feedback
 * endpoint.
 */
export function PhotoQuotePanel({ jobId }: { jobId: string }) {
  const [result, setResult] = useState<PhotoQuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [fileState, setFile] = useState<File | null>(null);

  function submit() {
    if (!fileState) {
      setError('Take a photo first');
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        // 1. Get an upload URL.
        const ext = (fileState.name.split('.').pop() ?? 'jpg').toLowerCase();
        const urlRes = await apiClientFetch<{
          uploadUrl: string;
          storageKey: string;
        }>(`/api/v1/jobs/${jobId}/photos/upload-url`, {
          method: 'POST',
          body: JSON.stringify({
            contentType: fileState.type || 'image/jpeg',
            extension: /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'jpg',
            label: 'photo-quote',
          }),
        });
        if (urlRes.status !== 200 || !urlRes.body.data) {
          setError(urlRes.body.error?.message ?? 'Upload prepare failed');
          return;
        }
        const { uploadUrl, storageKey } = urlRes.body.data;
        if (!uploadUrl.startsWith('stub://')) {
          const put = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': fileState.type || 'image/jpeg' },
            body: fileState,
          });
          if (!put.ok) {
            setError(`Upload failed: ${put.status}`);
            return;
          }
        }
        // 2. Run the pipeline.
        const res = await apiClientFetch<PhotoQuoteResult>(
          `/api/v1/jobs/${jobId}/photo-quote`,
          {
            method: 'POST',
            body: JSON.stringify({
              imageRef: storageKey,
            }),
          },
        );
        if (res.status !== 200 || !res.body.data) {
          setError(res.body.error?.message ?? 'Photo quote failed');
          return;
        }
        setResult(res.body.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unexpected error');
      }
    });
  }

  function feedback(
    kind: 'accept' | 'override',
    candidate: Candidate,
  ) {
    if (!result) return;
    void apiClientFetch('/api/v1/ai/feedback', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: result.conversationId,
        kind,
        subjectKind: 'photo_quote_item',
        subjectRef: {
          serviceItemId: candidate.serviceItemId,
          sku: candidate.sku,
          confidence: candidate.confidence,
        },
      }),
    });
  }

  return (
    <section
      data-testid="photo-quote-panel"
      className="mt-6 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-800">Photo quote</h2>
      <p className="mt-1 text-xs text-slate-500">
        Snap the failure — AI will pull candidate line items from the pricebook.
      </p>
      <div className="mt-3 flex gap-2 items-center">
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm"
          data-testid="photo-quote-input"
        />
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          data-testid="photo-quote-submit"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Analysing…' : 'Get quote'}
        </button>
      </div>
      {error && (
        <div role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {result && (
        <div className="mt-4">
          <p className="text-xs text-slate-500">
            {result.vision.make ?? 'Unknown make'} ·{' '}
            {result.vision.failureMode ?? 'unrecognised'} ·{' '}
            {(result.vision.confidence * 100).toFixed(0)}%
          </p>
          <ul className="mt-2 divide-y divide-slate-100">
            {result.candidates.length === 0 ? (
              <li className="py-3 text-sm text-slate-500">
                No candidate line items — try a clearer photo.
              </li>
            ) : (
              result.candidates.map((c) => (
                <li key={c.serviceItemId} className="py-3 space-y-1">
                  <div className="flex justify-between gap-2 items-start">
                    <div>
                      <div className="font-medium text-slate-900">{c.name}</div>
                      <div className="text-xs font-mono text-slate-500">
                        {c.sku}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-medium">
                        ${Number(c.unitPriceDollars).toFixed(2)}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">
                        {(c.confidence * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600">{c.reasoning}</p>
                  {c.requiresConfirmation && (
                    <p className="text-xs text-amber-700">
                      Above the quote cap — confirm before adding.
                    </p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => feedback('accept', c)}
                      data-testid="pq-accept"
                      className="rounded-md bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => feedback('override', c)}
                      data-testid="pq-override"
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Override
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
