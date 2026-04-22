import { describe, it, expect } from 'vitest';
import {
  generateInviteToken,
  hashInviteToken,
  INVITE_TOKEN_TTL_MS,
} from '../invite-token.js';

describe('generateInviteToken', () => {
  it('produces a URL-safe base64 token of length 43', () => {
    const { token } = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces a 64-character hex SHA-256 hash', () => {
    const { hash } = generateInviteToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the token it returns (round-trip)', () => {
    const { token, hash } = generateInviteToken();
    expect(hashInviteToken(token)).toBe(hash);
  });

  it('produces different tokens and hashes on successive calls', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('hashInviteToken', () => {
  it('is deterministic for the same input', () => {
    const h1 = hashInviteToken('some-token');
    const h2 = hashInviteToken('some-token');
    expect(h1).toBe(h2);
  });

  it('diverges for different inputs', () => {
    expect(hashInviteToken('a')).not.toBe(hashInviteToken('b'));
  });
});

describe('INVITE_TOKEN_TTL_MS', () => {
  it('equals 72 hours in milliseconds', () => {
    expect(INVITE_TOKEN_TTL_MS).toBe(72 * 60 * 60 * 1000);
  });
});
