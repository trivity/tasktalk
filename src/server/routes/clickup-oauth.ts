import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db/client.js';
import { clickupConnections } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../env.js';
import { encryptToken } from '../db/encrypt.js';
import {
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForToken,
} from '../mcp/oauth.js';
import { requireAuth } from '../auth/middleware.js';
import { randomBytes } from 'node:crypto';
import { getBoss, QUEUE_INITIAL_SYNC } from '../sync/boss.js';
import { ensureWorkspaceWebhook } from '../sync/webhooks.js';

const PKCE_COOKIE = 'tt_oauth_pkce';
const STATE_COOKIE = 'tt_oauth_state';

export const clickupOauthRoutes = new Hono()
  .get('/connect', requireAuth, async (c) => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = randomBytes(16).toString('hex');
    const redirectUri = `${env.BASE_URL}/api/clickup/callback`;
    setCookie(c, PKCE_COOKIE, codeVerifier, { httpOnly: true, secure: env.BASE_URL.startsWith('https'), sameSite: 'Lax', path: '/', maxAge: 600 });
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: env.BASE_URL.startsWith('https'), sameSite: 'Lax', path: '/', maxAge: 600 });
    const url = buildAuthorizeUrl({
      clientId: env.CLICKUP_OAUTH_CLIENT_ID,
      redirectUri,
      codeChallenge,
      state,
    });
    return c.redirect(url);
  })
  .get('/callback', requireAuth, async (c) => {
    const u = c.get('user');
    const code = c.req.query('code');
    const stateParam = c.req.query('state');
    const codeVerifier = getCookie(c, PKCE_COOKIE);
    const stateCookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, PKCE_COOKIE, { path: '/' });
    deleteCookie(c, STATE_COOKIE, { path: '/' });

    if (!code || !codeVerifier || !stateParam || stateParam !== stateCookie) {
      return c.redirect('/settings?clickup=error');
    }

    const redirectUri = `${env.BASE_URL}/api/clickup/callback`;
    const tokenResp = await exchangeCodeForToken({ code, codeVerifier, redirectUri });

    // ClickUp returns the workspace id in the token scope or via a separate call;
    // for now, fetch the user's authorized workspaces via a small probe.
    const workspaceId = await fetchPrimaryWorkspaceId(tokenResp.access_token);

    await db.insert(clickupConnections).values({
      userId: u.id,
      workspaceId,
      accessTokenEnc: encryptToken(tokenResp.access_token, env.TOKEN_ENCRYPTION_KEY),
      refreshTokenEnc: encryptToken(tokenResp.refresh_token, env.TOKEN_ENCRYPTION_KEY),
      expiresAt: new Date(Date.now() + tokenResp.expires_in * 1000),
      scopes: tokenResp.scope ?? null,
    });

    const boss = await getBoss();
    await boss.send(QUEUE_INITIAL_SYNC, { userId: u.id });
    try { await ensureWorkspaceWebhook(u.id, workspaceId); } catch (e) { console.error('[clickup] webhook register failed', e); }

    return c.redirect('/settings?clickup=connected');
  })
  .post('/disconnect', requireAuth, async (c) => {
    const u = c.get('user');
    await db
      .update(clickupConnections)
      .set({ tombstonedAt: new Date() })
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)));
    return c.json({ ok: true });
  })
  .get('/status', requireAuth, async (c) => {
    const u = c.get('user');
    const [row] = await db
      .select({ workspaceId: clickupConnections.workspaceId, expiresAt: clickupConnections.expiresAt, tombstonedAt: clickupConnections.tombstonedAt })
      .from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)))
      .limit(1);
    return c.json({ connected: !!row, connection: row ?? null });
  });

async function fetchPrimaryWorkspaceId(accessToken: string): Promise<string> {
  const res = await fetch('https://api.clickup.com/api/v2/team', {
    headers: { Authorization: accessToken },
  });
  if (!res.ok) throw new Error(`ClickUp team fetch failed: ${res.status}`);
  const data = (await res.json()) as { teams: Array<{ id: string }> };
  if (!data.teams?.length) throw new Error('No accessible ClickUp workspaces');
  return data.teams[0]!.id;
}
