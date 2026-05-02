import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { env } from '../env.js';
import {
  createSession,
  deleteSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from './session.js';
import { issueMagicLinkToken, verifyMagicLinkToken } from './magic-link.js';
import { hashPassword, verifyPassword } from './password.js';
import { sendMagicLinkEmail } from '../email/resend.js';
import { requireAuth, requireAdmin } from './middleware.js';
import {
  loginRequest,
  callbackRequest,
  inviteRequest,
  setPasswordRequest,
} from '../../shared/schemas/api.js';

export const authRoutes = new Hono()
  .post('/login', zValidator('json', loginRequest), async (c) => {
    const body = c.req.valid('json');
    const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!u) return c.json({ ok: true }); // do not reveal whether account exists
    if (body.method === 'magic_link') {
      const raw = await issueMagicLinkToken(u.id);
      const link = `${env.BASE_URL}/login/callback?token=${encodeURIComponent(raw)}`;
      await sendMagicLinkEmail(u.email, link);
      return c.json({ ok: true });
    }
    const ok = await verifyPassword(u.passwordHash, body.password);
    if (!ok) return c.json({ error: 'invalid_credentials' }, 401);
    const sess = await createSession(u.id);
    setCookie(c, SESSION_COOKIE_NAME, sess.id, {
      httpOnly: true,
      secure: env.BASE_URL.startsWith('https'),
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin } });
  })
  .post('/login/callback', zValidator('json', callbackRequest), async (c) => {
    const { token } = c.req.valid('json');
    const userId = await verifyMagicLinkToken(token);
    if (!userId) return c.json({ error: 'invalid_or_expired_token' }, 400);
    const sess = await createSession(userId);
    setCookie(c, SESSION_COOKIE_NAME, sess.id, {
      httpOnly: true,
      secure: env.BASE_URL.startsWith('https'),
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return c.json({ ok: true, user: { id: u!.id, email: u!.email, name: u!.name, isAdmin: u!.isAdmin } });
  })
  .post('/logout', requireAuth, async (c) => {
    const sid = getCookie(c, SESSION_COOKIE_NAME);
    if (sid) await deleteSession(sid);
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.json({ ok: true });
  })
  .get('/me', requireAuth, (c) => c.json({ user: c.get('user') }))
  .post('/me/password', requireAuth, zValidator('json', setPasswordRequest), async (c) => {
    const u = c.get('user');
    const { password } = c.req.valid('json');
    const hash = await hashPassword(password);
    await db.update(users).set({ passwordHash: hash, updatedAt: new Date() }).where(eq(users.id, u.id));
    return c.json({ ok: true });
  })
  .post('/members/invite', requireAuth, requireAdmin, zValidator('json', inviteRequest), async (c) => {
    const { email, name } = c.req.valid('json');
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    let userId: string;
    if (existing.length) {
      userId = existing[0]!.id;
    } else {
      const [created] = await db.insert(users).values({ email, name }).returning();
      userId = created!.id;
    }
    const raw = await issueMagicLinkToken(userId);
    const link = `${env.BASE_URL}/login/callback?token=${encodeURIComponent(raw)}`;
    await sendMagicLinkEmail(email, link);
    return c.json({ ok: true });
  });
