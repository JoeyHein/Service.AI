'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

interface Photo {
  id: string;
  label: string | null;
  contentType: string | null;
  downloadUrl: string;
  createdAt: string;
}

interface UploadSpec {
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
}

export function JobPhotos({
  jobId,
  initialPhotos,
}: {
  jobId: string;
  initialPhotos: Photo[];
}) {
  const router = useRouter();
  const [photos, setPhotos] = useState<Photo[]>(initialPhotos);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  function upload() {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setError(null);
    startTransition(async () => {
      const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase();
      const urlRes = await apiClientFetch<UploadSpec>(
        `/api/v1/jobs/${jobId}/photos/upload-url`,
        {
          method: 'POST',
          body: JSON.stringify({
            contentType: file.type || 'image/jpeg',
            extension: /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'jpg',
            label: label || null,
          }),
        },
      );
      if (urlRes.status !== 200 || !urlRes.body.data) {
        setError(urlRes.body.error?.message ?? 'Could not get upload URL.');
        return;
      }
      const { uploadUrl, storageKey } = urlRes.body.data;
      // For the dev stub the upload URL is stub:// — skip actual PUT.
      // Production (real DO Spaces presigned URL) the browser PUTs the bytes.
      if (!uploadUrl.startsWith('stub://')) {
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': file.type || 'image/jpeg' },
          body: file,
        });
        if (!putRes.ok) {
          setError(`Upload failed: ${putRes.status}`);
          return;
        }
      }
      const finalise = await apiClientFetch<Photo>(
        `/api/v1/jobs/${jobId}/photos`,
        {
          method: 'POST',
          body: JSON.stringify({
            storageKey,
            contentType: file.type || 'image/jpeg',
            sizeBytes: file.size,
            label: label || null,
          }),
        },
      );
      if (finalise.status !== 201 || !finalise.body.data) {
        setError(finalise.body.error?.message ?? 'Could not finalise photo.');
        return;
      }
      setPhotos((prev) => [finalise.body.data!, ...prev]);
      setLabel('');
      if (fileInput.current) fileInput.current.value = '';
      router.refresh();
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const res = await apiClientFetch(`/api/v1/jobs/${jobId}/photos/${id}`, {
        method: 'DELETE',
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Could not delete photo.');
        return;
      }
      setPhotos((prev) => prev.filter((p) => p.id !== id));
      router.refresh();
    });
  }

  return (
    <div>
      <h2 className="text-sm font-medium text-slate-700">Photos</h2>
      <div
        data-testid="photo-gallery"
        className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
      >
        {photos.length === 0 ? (
          <p className="text-sm text-slate-500 col-span-full">No photos yet.</p>
        ) : (
          photos.map((p) => (
            <div
              key={p.id}
              className="rounded border border-slate-200 overflow-hidden bg-white"
            >
              {p.downloadUrl.startsWith('stub://') ? (
                <div className="bg-slate-100 h-32 flex items-center justify-center text-xs text-slate-500 font-mono">
                  {p.label ?? 'photo'}
                </div>
              ) : (
                <a href={p.downloadUrl} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.downloadUrl}
                    alt={p.label ?? 'job photo'}
                    className="h-32 w-full object-cover"
                  />
                </a>
              )}
              <div className="flex items-center justify-between px-2 py-1 text-xs text-slate-600">
                <span>{p.label ?? '—'}</span>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  className="text-red-700 hover:underline disabled:opacity-50"
                  disabled={pending}
                >
                  remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-4 bg-white rounded-lg border border-slate-200 p-4">
        <h3 className="text-sm font-medium text-slate-700">Upload photo</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="text-sm"
            data-testid="photo-file-input"
          />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={upload}
            disabled={pending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {pending ? 'Uploading…' : 'Upload'}
          </button>
        </div>
        {error && (
          <div
            role="alert"
            className="mt-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
