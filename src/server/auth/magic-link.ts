import { randomBytes, createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { authTokens } from '../db/schema.js';
import { and, eq, isNull, gt } from 'drizzle-orm';

const TTL_MS = 15 * 60 * 1000;

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

export async function issueMagicLinkToken(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[dev] magic link for user=${userId} token=${raw}`);
  }
  await db.insert(authTokens).values({
    userId,
    purpose: 'magic_link',
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return raw;
}

export async function verifyMagicLinkToken(raw: string): Promise<string | null> {
  const hashed = hashToken(raw);
  const [row] = await db
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, hashed),
        eq(authTokens.purpose, 'magic_link'),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  await db.update(authTokens).set({ consumedAt: new Date() }).where(eq(authTokens.id, row.id));
  return row.userId;
}
