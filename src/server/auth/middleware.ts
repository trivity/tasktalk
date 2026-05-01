import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { findSession, SESSION_COOKIE_NAME } from './session.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export type AuthedUser = { id: string; email: string; name: string | null; isAdmin: boolean };

declare module 'hono' {
  interface ContextVariableMap { user: AuthedUser }
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE_NAME);
  if (!sid) return c.json({ error: 'unauthenticated' }, 401);
  const sess = await findSession(sid);
  if (!sess) return c.json({ error: 'unauthenticated' }, 401);
  const [u] = await db.select().from(users).where(eq(users.id, sess.userId)).limit(1);
  if (!u) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin });
  await next();
};

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const u = c.get('user');
  if (!u?.isAdmin) return c.json({ error: 'forbidden' }, 403);
  await next();
};
