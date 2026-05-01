import { randomBytes, createHmac } from 'node:crypto';
import { db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { eq, lt } from 'drizzle-orm';
import { env } from '../env.js';

export const SESSION_COOKIE_NAME = 'tt_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateSessionId(): string {
  return randomBytes(32).toString('hex');
}

export function hashSessionId(id: string): string {
  return createHmac('sha256', env.SESSION_COOKIE_SECRET).update(id).digest('hex');
}

export function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = generateSessionId();
  const expiresAt = sessionExpiry();
  await db.insert(sessions).values({ id: hashSessionId(id), userId, expiresAt });
  return { id, expiresAt };
}

export async function findSession(rawId: string) {
  const hashed = hashSessionId(rawId);
  const [row] = await db.select().from(sessions).where(eq(sessions.id, hashed)).limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, hashed));
    return null;
  }
  return row;
}

export async function deleteSession(rawId: string) {
  await db.delete(sessions).where(eq(sessions.id, hashSessionId(rawId)));
}

export async function purgeExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
