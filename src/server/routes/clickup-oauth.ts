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
import { openMcpSessionWithToken } from '../mcp/client.js';
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

    // ClickUp's MCP OAuth registration only grants 'authorization_code' (no refresh_token
    // grant), so tokenResp.refresh_token is often undefined. Encrypt empty in that case;
    // auto-refresh will be a no-op until the access token expires (typical: long TTL).
    const refreshTokenPlain = tokenResp.refresh_token ?? '';
    await db.insert(clickupConnections).values({
      userId: u.id,
      workspaceId,
      accessTokenEnc: encryptToken(tokenResp.access_token, env.TOKEN_ENCRYPTION_KEY),
      refreshTokenEnc: encryptToken(refreshTokenPlain, env.TOKEN_ENCRYPTION_KEY),
      expiresAt: new Date(Date.now() + (tokenResp.expires_in ?? 86400 * 30) * 1000),
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

/**
 * Discover the user's primary ClickUp workspace_id via the MCP server.
 * The MCP-issued OAuth token is only valid against mcp.clickup.com (NOT
 * api.clickup.com), so we connect to MCP and look at what tools / resources
 * its session exposes for workspace identification.
 *
 * If discovery fails (the MCP server doesn't expose a clear workspace tool,
 * or its response shape isn't what we expect), we fall back to an opaque
 * placeholder and let the worker resolve it on first sync. The connection
 * still gets created — the OAuth flow doesn't fail just because we can't
 * pin down the workspace id at callback time.
 */
async function fetchPrimaryWorkspaceId(accessToken: string): Promise<string> {
  let session: Awaited<ReturnType<typeof openMcpSessionWithToken>> | null = null;
  try {
    session = await openMcpSessionWithToken(accessToken);

    // Inspect what tools and resources the MCP server exposes for this user.
    // We look for any that surface workspace / team / space identifiers.
    const toolsResp = await session.client.listTools();
    const toolNames = toolsResp.tools.map((t) => t.name);
    console.log('[clickup-oauth] MCP tools available:', toolNames);

    // ClickUp's MCP exposes `clickup_get_workspace_hierarchy` which returns the
    // full tree (workspace → spaces → folders → lists) in one call — perfect for
    // discovery. We try it first; fall back to other plausible names.
    const candidates = [
      'clickup_get_workspace_hierarchy',
      'clickup_get_workspace_members', // workspace_id is in member objects
      'clickup_get_workspaces', 'clickup_list_workspaces',
      'clickup_get_teams', 'clickup_list_teams',
    ];
    for (const name of candidates) {
      if (!toolNames.includes(name)) continue;
      try {
        const result = await session.client.callTool({ name, arguments: {} });
        const wsId = extractWorkspaceId(result);
        if (wsId) {
          console.log(`[clickup-oauth] discovered workspace_id=${wsId} via ${name}`);
          return wsId;
        }
        console.log(`[clickup-oauth] ${name} returned but no workspace_id extracted; raw:`, JSON.stringify(result).slice(0, 500));
      } catch (e) {
        console.warn(`[clickup-oauth] ${name} failed:`, (e as Error).message);
      }
    }

    // Last resort: list resources and look for a workspace in the URI/metadata.
    try {
      const resourcesResp = await session.client.listResources();
      console.log('[clickup-oauth] MCP resources:', resourcesResp.resources.map((r) => r.uri));
      for (const r of resourcesResp.resources) {
        const m = r.uri.match(/(?:workspace|team)[/_:](\d+)/i);
        if (m) return m[1]!;
      }
    } catch { /* server may not expose resources */ }

    console.warn('[clickup-oauth] could not discover workspace_id; using placeholder. Initial sync will resolve it.');
    return `pending-${Date.now()}`;
  } finally {
    if (session) await session.close();
  }
}

function extractWorkspaceId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;

  // Direct array shapes (teams[]/workspaces[])
  for (const key of ['teams', 'workspaces']) {
    const arr = r[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as Record<string, unknown>;
      if (first.id != null) return String(first.id);
    }
  }

  // get_workspace_hierarchy may return a tree with the workspace at the root.
  // Common shapes: { workspace: { id, ... } } or { id, name, spaces: [...] }
  if (r.workspace && typeof r.workspace === 'object') {
    const ws = r.workspace as Record<string, unknown>;
    if (ws.id != null) return String(ws.id);
  }
  if (r.team && typeof r.team === 'object') {
    const t = r.team as Record<string, unknown>;
    if (t.id != null) return String(t.id);
  }
  // Sometimes the root object IS the workspace (has id + spaces siblings).
  if (r.id != null && Array.isArray(r.spaces)) return String(r.id);
  if (r.id != null && typeof r.name === 'string' && r.id != null && String(r.id).match(/^\d+$/)) {
    return String(r.id);
  }

  // Spaces in any shape often carry team_id / workspace_id.
  if (Array.isArray(r.spaces) && r.spaces.length > 0) {
    const first = r.spaces[0] as Record<string, unknown>;
    const teamId = first.team_id ?? first.teamId ?? first.workspace_id ?? first.workspaceId;
    if (teamId != null) return String(teamId);
  }

  // get_workspace_members returns { members: [{ user: {...}, workspace_id?: ... }, ...] }
  // or sometimes the team is at the top level.
  if (Array.isArray(r.members) && r.members.length > 0) {
    const first = r.members[0] as Record<string, unknown>;
    const wsId = first.workspace_id ?? first.team_id;
    if (wsId != null) return String(wsId);
  }

  // MCP tool wrapping: { content: [{ type: 'text', text: '<json>' }] }
  const content = r.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        try {
          const parsed = JSON.parse(b.text) as unknown;
          const inner = extractWorkspaceId(parsed);
          if (inner) return inner;
        } catch { /* not JSON */ }
      }
      if (b.type === 'resource' && b.resource) {
        const inner = extractWorkspaceId(b.resource);
        if (inner) return inner;
      }
    }
  }

  return null;
}
