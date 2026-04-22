/**
 * @service-ai/auth — Better Auth wiring for Service.AI.
 *
 * Exports a `createAuth(deps)` factory that returns a configured Better Auth
 * instance, plus a `getSession(headers)` helper and a `MagicLinkSender`
 * interface so the email delivery backend is pluggable across white-label
 * tenants.
 *
 * Side effects: the returned auth instance reads its secret and base URL from
 * its config; it does not open any sockets at construction time. Magic-link
 * delivery runs through the injected MagicLinkSender — the default
 * `loggingSender` only writes to stdout.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';

import { loggingSender, type MagicLinkSender } from './sender.js';

export { loggingSender };
export type { MagicLinkSender, MagicLinkPayload } from './sender.js';

/**
 * Narrow shape of the Drizzle client Better Auth needs. Taking a structural
 * type here keeps @service-ai/auth from importing @service-ai/db directly,
 * which would create a dependency cycle (db depends on auth-schema shapes).
 */
export interface AuthDb {
  [k: string]: unknown;
}

export interface CreateAuthOptions {
  db: AuthDb;
  /** Full origin (protocol+host) the API serves auth routes under. */
  baseUrl: string;
  /** Random secret; production deployments use a 32+ byte value. */
  secret: string;
  /** Email sender. Defaults to `loggingSender` (dev stub). */
  magicLinkSender?: MagicLinkSender;
  /** Set to true in production to mark cookies secure. */
  production?: boolean;
}

/**
 * Builds a configured Better Auth instance. Called once per process in
 * production and once per test when a fresh in-memory instance is needed.
 */
export function createAuth(opts: CreateAuthOptions) {
  const sender = opts.magicLinkSender ?? loggingSender;

  return betterAuth({
    baseURL: opts.baseUrl,
    secret: opts.secret,
    database: drizzleAdapter(opts.db as never, { provider: 'pg' }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },
    advanced: {
      cookies: {
        session_token: {
          attributes: {
            httpOnly: true,
            sameSite: 'lax',
            secure: opts.production === true,
          },
        },
      },
    },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sender.send({ email, url, purpose: 'signin' });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Resolve the session for an incoming request. Returns `null` when no session
 * cookie is present or the session has expired. Never throws on missing auth —
 * callers decide whether to 401 or continue as anonymous.
 */
export async function getSession(
  auth: Auth,
  headers: Headers,
): Promise<{ userId: string; sessionId: string } | null> {
  const result = await auth.api.getSession({ headers });
  if (!result || !result.session || !result.user) return null;
  return { userId: result.user.id, sessionId: result.session.id };
}
