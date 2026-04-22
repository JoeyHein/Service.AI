/**
 * Invite token generation and hashing.
 *
 * Invitations store only the SHA-256 hex digest of the token. The raw token
 * is emitted exactly once at creation time, included in the invite email,
 * and never stored server-side after that. A database leak therefore
 * cannot be used to redeem pending invites.
 *
 * Tokens are 32 cryptographically random bytes, base64url-encoded so they
 * survive URL path segments without escaping.
 */
import { randomBytes, createHash } from 'node:crypto';

/** 32 bytes → 43-character base64url string with no padding. */
const TOKEN_BYTES = 32;

/**
 * base64url encoding (RFC 4648 §5) using the same alphabet as JWT: `+` → `-`,
 * `/` → `_`, and trailing `=` padding stripped. Safe for URL path segments.
 */
function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface GeneratedToken {
  /** Raw token to embed in the invite link. Never persist this. */
  token: string;
  /** SHA-256 hex digest, persisted as invitations.token_hash. */
  hash: string;
}

/**
 * Produce a fresh invite token plus its DB-storable hash. Call once per
 * invite; keep `token` only long enough to send the email, then drop it.
 */
export function generateInviteToken(): GeneratedToken {
  const raw = randomBytes(TOKEN_BYTES);
  const token = toBase64Url(raw);
  return { token, hash: hashInviteToken(token) };
}

/**
 * Hash a raw invite token for database lookup. Deterministic — the same
 * token always produces the same hash, so redemption can locate the row
 * by WHERE token_hash = hashInviteToken(submittedToken).
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const INVITE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
