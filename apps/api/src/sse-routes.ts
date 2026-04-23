/**
 * Server-Sent Events stream for dispatch (TASK-DB-03).
 *
 *   GET /api/v1/jobs/events/stream   text/event-stream
 *
 * Subscribes the caller to the EventBus with a predicate that keeps
 * them in their scope. Heartbeat comment every 15 seconds so proxies
 * don't close idle connections.
 *
 * Only payload IDs travel on the wire — clients re-fetch
 * /api/v1/jobs/:id for details, which is already scope-filtered.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { franchisees } from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { EventBus, DispatchEvent } from './event-bus.js';

type Drizzle = NodePgDatabase<typeof schema>;

const HEARTBEAT_MS = 15_000;

export function registerSseRoutes(
  app: FastifyInstance,
  db: Drizzle,
  bus: EventBus,
): void {
  app.get(
    '/api/v1/jobs/events/stream',
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      const scope = req.scope;

      // Build a scope-filter predicate once per connection. For
      // franchisor callers we need the set of their franchisee ids.
      let franchiseeIdsForFranchisor = new Set<string>();
      if (scope.type === 'franchisor') {
        const rows = await db
          .select({ id: franchisees.id })
          .from(franchisees)
          .where(eq(franchisees.franchisorId, scope.franchisorId));
        franchiseeIdsForFranchisor = new Set(rows.map((r) => r.id));
      }

      function matches(event: DispatchEvent): boolean {
        if (scope.type === 'platform') return true;
        if (scope.type === 'franchisor')
          return franchiseeIdsForFranchisor.has(event.franchiseeId);
        return event.franchiseeId === scope.franchiseeId;
      }

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Disable Nginx/proxy buffering
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': connected\n\n');

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': keepalive\n\n');
        } catch {
          // Connection closed between ticks; cleanup handles the rest.
        }
      }, HEARTBEAT_MS);

      const unsubscribe = bus.subscribe(matches, (event) => {
        try {
          reply.raw.write(`event: ${event.type}\n`);
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Consumer has gone away; the close handler below tears down.
        }
      });

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);

      // Keep the handler alive — Fastify would otherwise resolve the
      // reply when the function returns.
      return reply;
    },
  );
}
