'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { apiClientFetch } from '../../../lib/api.js';

export interface JobCard {
  id: string;
  title: string;
  status: string;
  assignedTechUserId: string | null;
  scheduledStart: string | null;
}

export interface Tech {
  userId: string;
  name: string | null;
  email: string;
}

const UNASSIGNED_COLUMN = 'unassigned';

export function DispatchBoard({
  initialJobs,
  techs,
}: {
  initialJobs: JobCard[];
  techs: Tech[];
}) {
  const [jobs, setJobs] = useState<JobCard[]>(initialJobs);
  const [error, setError] = useState<string | null>(null);
  // jobsRef stays in sync via an effect so the drag handler can read
  // the latest jobs without stale closures. React's refs-during-render
  // lint rule forbids the assign-during-render shortcut.
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Subscribe to the SSE stream. On every event we re-fetch /api/v1/jobs
  // rather than trying to reconcile payload-light events — simpler, and
  // the refresh is bounded by scope so the cost is acceptable.
  useEffect(() => {
    const es = new EventSource('/api/v1/jobs/events/stream', {
      withCredentials: true,
    });
    const refresh = async () => {
      const res = await apiClientFetch<{
        rows: JobCard[];
      }>('/api/v1/jobs?limit=200');
      if (res.status === 200 && res.body.ok && res.body.data) {
        const visible = (res.body.data.rows as unknown as JobCard[])
          .filter((j) => !['completed', 'canceled'].includes(j.status));
        setJobs(visible);
      }
    };
    const handler = () => refresh();
    es.addEventListener('job.assigned', handler);
    es.addEventListener('job.unassigned', handler);
    es.addEventListener('job.transitioned', handler);
    return () => {
      es.removeEventListener('job.assigned', handler);
      es.removeEventListener('job.unassigned', handler);
      es.removeEventListener('job.transitioned', handler);
      es.close();
    };
  }, []);

  const columns = useMemo(() => {
    const base = new Map<string, JobCard[]>();
    base.set(UNASSIGNED_COLUMN, []);
    for (const t of techs) base.set(t.userId, []);
    for (const j of jobs) {
      const key = j.assignedTechUserId ?? UNASSIGNED_COLUMN;
      if (!base.has(key)) base.set(key, []);
      base.get(key)!.push(j);
    }
    return base;
  }, [jobs, techs]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  async function onDragEnd(event: DragEndEvent) {
    const jobId = String(event.active.id);
    const to = event.over ? String(event.over.id) : null;
    if (!to) return;
    const current = jobsRef.current.find((j) => j.id === jobId);
    if (!current) return;
    const currentCol = current.assignedTechUserId ?? UNASSIGNED_COLUMN;
    if (currentCol === to) return;

    // Optimistic move
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? { ...j, assignedTechUserId: to === UNASSIGNED_COLUMN ? null : to }
          : j,
      ),
    );

    if (to === UNASSIGNED_COLUMN) {
      const res = await apiClientFetch(`/api/v1/jobs/${jobId}/unassign`, {
        method: 'POST',
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Unassign failed');
        // Rollback — SSE event will re-sync anyway but give immediate visual
        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId ? { ...j, assignedTechUserId: current.assignedTechUserId } : j,
          ),
        );
      }
    } else {
      const res = await apiClientFetch(`/api/v1/jobs/${jobId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ assignedTechUserId: to }),
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Assign failed');
        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId ? { ...j, assignedTechUserId: current.assignedTechUserId } : j,
          ),
        );
      }
    }
  }

  return (
    <>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
        >
          {error}{' '}
          <button
            type="button"
            onClick={() => setError(null)}
            className="underline text-xs"
          >
            dismiss
          </button>
        </div>
      )}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div
          data-testid="dispatch-board"
          className="grid grid-flow-col auto-cols-[minmax(240px,_1fr)] gap-4 overflow-x-auto pb-4"
        >
          <Column
            id={UNASSIGNED_COLUMN}
            title="Unassigned"
            jobs={columns.get(UNASSIGNED_COLUMN) ?? []}
          />
          {techs.map((t) => (
            <Column
              key={t.userId}
              id={t.userId}
              title={t.name ?? t.email}
              jobs={columns.get(t.userId) ?? []}
            />
          ))}
        </div>
      </DndContext>
    </>
  );
}

function Column({ id, title, jobs }: { id: string; title: string; jobs: JobCard[] }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-testid={`column-${id}`}
      className={`rounded-lg border border-slate-200 bg-white ${isOver ? 'ring-2 ring-blue-400' : ''}`}
    >
      <header className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-600">
        {title} <span className="text-slate-400">({jobs.length})</span>
      </header>
      <ul className="p-2 space-y-2 min-h-[120px]">
        {jobs.map((j) => (
          <JobCardView key={j.id} job={j} />
        ))}
        {jobs.length === 0 && (
          <li className="text-xs text-slate-400 px-1 py-4 text-center">
            drop here
          </li>
        )}
      </ul>
    </div>
  );
}

function JobCardView({ job }: { job: JobCard }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: job.id,
  });
  const style: React.CSSProperties = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : {};
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`job-card-${job.id}`}
      {...attributes}
      {...listeners}
      className={`rounded border border-slate-200 bg-white px-3 py-2 text-sm cursor-grab ${isDragging ? 'opacity-40' : ''}`}
    >
      <div className="font-medium text-slate-900 truncate">{job.title}</div>
      <div className="flex justify-between items-center text-xs mt-1">
        <span className="font-mono text-slate-500">{job.status}</span>
        <Link
          href={`/jobs/${job.id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-blue-700 hover:underline text-[11px]"
        >
          open →
        </Link>
      </div>
    </li>
  );
}
