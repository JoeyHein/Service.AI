/**
 * Better Auth mount for Fastify.
 *
 * Better Auth's handler is framework-agnostic: it takes a Web-standard
 * Request and returns a Response. This module bridges Fastify's request/
 * reply objects to that interface and mounts the handler on /api/auth/*.
 *
 * Kept separate from app.ts so the Fastify factory stays focused on plugin
 * wiring, and so tests can exercise the conversion helpers directly.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Auth } from '@service-ai/auth';
import { getSession } from '@service-ai/auth';

/** Convert a Fastify request to a standard Web Request for Better Auth. */
function toWebRequest(req: FastifyRequest): Request {
  const url = new URL(
    req.url,
    `${req.protocol}://${req.headers.host ?? 'localhost'}`,
  );

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(', '));
    else if (typeof v === 'string') headers.set(k, v);
  }

  const init: RequestInit = { method: req.method, headers };
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    init.body =
      typeof req.body === 'string'
        ? req.body
        : req.body == null
          ? undefined
          : JSON.stringify(req.body);
  }
  return new Request(url.toString(), init);
}

/** Pipe a Web Response back through a Fastify reply. */
async function fromWebResponse(res: Response, reply: FastifyReply): Promise<void> {
  reply.status(res.status);
  res.headers.forEach((value, key) => {
    // `set-cookie` can appear multiple times — Headers collapses it to one
    // comma-joined string. Fastify's `header` will set it correctly.
    reply.header(key, value);
  });
  const body = res.body ? await res.text() : '';
  reply.send(body);
}

/**
 * Mount Better Auth on `/api/auth/*` and expose `GET /api/v1/me` which
 * returns the current authenticated user (without scope data — scopes land
 * in TASK-TEN-03 once RequestScope middleware exists).
 */
export function mountAuth(app: FastifyInstance, auth: Auth): void {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const webReq = toWebRequest(req);
      const webRes = await auth.handler(webReq);
      await fromWebResponse(webRes, reply);
    },
  });

  app.get('/api/v1/me', async (req, reply) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers.set(k, v.join(', '));
      else if (typeof v === 'string') headers.set(k, v);
    }
    const session = await getSession(auth, headers);
    if (!session) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'No valid session' },
      });
    }
    return reply.code(200).send({
      ok: true,
      data: {
        user: { id: session.userId },
        // Scopes intentionally empty — RequestScope middleware arrives in TEN-03.
        scopes: [],
      },
    });
  });
}
