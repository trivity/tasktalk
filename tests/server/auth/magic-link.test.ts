// Integration tests against a live Postgres (DATABASE_URL from .env).
// Inserts a unique user per run; relies on Plan A's cu_* migration being applied.
import { describe, it, expect, beforeAll } from 'vitest';
import { issueMagicLinkToken, verifyMagicLinkToken } from '../../../src/server/auth/magic-link.js';
import { db } from '../../../src/server/db/client.js';
import { users } from '../../../src/server/db/schema.js';

describe('magic link', () => {
  let userId: string;
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `ml-${Date.now()}@test` }).returning();
    userId = u!.id;
  });

  it('issues a token, verifies it, then rejects re-use', async () => {
    const token = await issueMagicLinkToken(userId);
    expect(token.length).toBeGreaterThan(20);
    const verifiedUserId = await verifyMagicLinkToken(token);
    expect(verifiedUserId).toBe(userId);
    expect(await verifyMagicLinkToken(token)).toBe(null);
  });

  it('rejects unknown token', async () => {
    expect(await verifyMagicLinkToken('not-a-real-token')).toBe(null);
  });
});
