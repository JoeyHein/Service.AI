/**
 * Better Auth mount for Fastify.
 *
 * Better Auth's handler is framework-agnostic: it takes a Web-standard
 * Request and returns a Response. This module bridges Fastify's request/
 * reply objects to that interface and mounts the handler on /api/auth/*.
 *
 * Also mounts /api/v1/me. That route reads `request.userId` and
 * `request.scope`, both set by the requestScopePlugin preHandler. Callers
 * must register requestScopePlugin before this mount; app.ts does so.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Auth } from '@service-ai/auth';

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
    reply.header(key, value);
  });
  const body = res.body ? await res.text() : '';
  reply.send(body);
}

/**
 * Mount Better Auth on `/api/auth/*` and expose `GET /api/v1/me` which
 * returns the current authenticated user plus the resolved scope. Both
 * values come from the requestScopePlugin which must be registered before
 * this call; /me returns 401 when no session exists and 200 with a null
 * scope when the user is authenticated but has no active membership.
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
    if (req.userId === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'No valid session' },
      });
    }
    return reply.code(200).send({
      ok: true,
      data: {
        user: { id: req.userId },
        scope: req.scope,
      },
    });
  });
}
