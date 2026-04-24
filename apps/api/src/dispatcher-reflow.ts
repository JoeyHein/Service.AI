/**
 * Cancellation reflow hook (TASK-DI-07).
 *
 * Subscribes to the EventBus for `job.transitioned` events; when
 * a job flips to `canceled`, marks any pending ai_suggestions
 * row targeting that job as `expired` so the human dispatcher
 * doesn't approve a no-longer-relevant proposal.
 *
 * Auto-apply on reflow is deliberately NOT wired — the phase-10
 * gate leaves that to human review to keep the blast radius
 * small. A future phase can add an automatic re-suggest path.
 */

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { aiSuggestions } from '@service-ai/db';
import type * as schema from '@service-ai/db';
import type { EventBus } from './event-bus.js';
import { logger } from './logger.js';

type Drizzle = NodePgDatabase<typeof schema>;

export function registerDispatcherReflow(
  db: Drizzle,
  bus: EventBus,
): () => void {
  return bus.subscribe(
    (e) => e.type === 'job.transitioned' && e.toStatus === 'canceled',
    async (e) => {
      try {
        const result = await db
          .update(aiSuggestions)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(
            and(
              eq(aiSuggestions.subjectJobId, e.jobId),
              eq(aiSuggestions.status, 'pending'),
            ),
          )
          .returning({ id: aiSuggestions.id });
        if (result.length > 0) {
          logger.info(
            { jobId: e.jobId, expired: result.length },
            'dispatcher reflow: expired suggestions for canceled job',
          );
        }
      } catch (err) {
        logger.error({ err, jobId: e.jobId }, 'dispatcher reflow failed');
      }
    },
  );
}
