import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db/client.js';
import { clickupConnections, cuWorkspaces, cuTasks, cuSpaces } from '../db/schema.js';
import { and, eq, isNull, inArray, sql } from 'drizzle-orm';
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

    // Enumerate ALL workspaces this token can see. The MCP may either:
    //   - reject `clickup_get_workspace_hierarchy` with "Multiple workspaces
    //     available: <ids>" error when the user has more than one
    //   - return a single-workspace hierarchy when exactly one
    const workspaceIds = await enumerateWorkspaces(tokenResp.access_token);

    // ClickUp's MCP OAuth registration only grants 'authorization_code' (no refresh_token
    // grant), so tokenResp.refresh_token is often undefined. Encrypt empty in that case;
    // auto-refresh will be a no-op until the access token expires (typical: long TTL).
    const refreshTokenPlain = tokenResp.refresh_token ?? '';
    const accessTokenEnc = encryptToken(tokenResp.access_token, env.TOKEN_ENCRYPTION_KEY);
    const refreshTokenEnc = encryptToken(refreshTokenPlain, env.TOKEN_ENCRYPTION_KEY);
    const expiresAt = new Date(Date.now() + (tokenResp.expires_in ?? 86400 * 30) * 1000);

    // Upsert one connection row per workspace. They share the same encrypted
    // token. If discovery failed entirely we fall back to one placeholder row
    // so the connection still exists and the worker can resolve it later.
    // The `(user_id, workspace_id) WHERE tombstoned_at IS NULL` partial unique
    // index ensures re-running OAuth never produces duplicates: existing
    // active rows get refreshed tokens, missing ones get inserted.
    const idsToInsert = workspaceIds.length > 0 ? workspaceIds : [`pending-${Date.now()}`];
    for (const wsId of idsToInsert) {
      const [existing] = await db
        .select({ id: clickupConnections.id })
        .from(clickupConnections)
        .where(and(
          eq(clickupConnections.userId, u.id),
          eq(clickupConnections.workspaceId, wsId),
          isNull(clickupConnections.tombstonedAt),
        ))
        .limit(1);
      if (existing) {
        await db
          .update(clickupConnections)
          .set({
            accessTokenEnc,
            refreshTokenEnc,
            expiresAt,
            scopes: tokenResp.scope ?? null,
          })
          .where(eq(clickupConnections.id, existing.id));
      } else {
        await db.insert(clickupConnections).values({
          userId: u.id,
          workspaceId: wsId,
          accessTokenEnc,
          refreshTokenEnc,
          expiresAt,
          scopes: tokenResp.scope ?? null,
        });
      }
    }

    const boss = await getBoss();
    // Single enqueue — runInitialSync iterates all of the user's workspaces
    // when no explicit workspaceId is provided.
    await boss.send(QUEUE_INITIAL_SYNC, { userId: u.id });
    for (const wsId of idsToInsert) {
      if (wsId.startsWith('pending-')) continue;
      try { await ensureWorkspaceWebhook(u.id, wsId); } catch (e) { console.error('[clickup] webhook register failed', e); }
    }

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
  .delete('/connections/:workspaceId', requireAuth, async (c) => {
    const u = c.get('user');
    const wsId = c.req.param('workspaceId');
    if (!wsId) return c.json({ error: 'workspace_id_required' }, 400);
    const result = await db
      .update(clickupConnections)
      .set({ tombstonedAt: new Date() })
      .where(and(
        eq(clickupConnections.userId, u.id),
        eq(clickupConnections.workspaceId, wsId),
        isNull(clickupConnections.tombstonedAt),
      ));
    return c.json({ ok: true, updated: (result as { rowCount?: number }).rowCount ?? 0 });
  })
  .get('/status', requireAuth, async (c) => {
    const u = c.get('user');
    const rows = await db
      .select({ workspaceId: clickupConnections.workspaceId, expiresAt: clickupConnections.expiresAt })
      .from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)));
    if (rows.length === 0) return c.json({ connected: false, connections: [] });

    const workspaceIds = rows.map((r) => r.workspaceId);
    const wsRows = workspaceIds.length > 0
      ? await db
          .select({
            workspaceId: cuWorkspaces.workspaceId,
            name: cuWorkspaces.name,
            lastFullSyncAt: cuWorkspaces.lastFullSyncAt,
            lastIncrementalSyncAt: cuWorkspaces.lastIncrementalSyncAt,
            syncState: cuWorkspaces.syncState,
          })
          .from(cuWorkspaces)
          .where(inArray(cuWorkspaces.workspaceId, workspaceIds))
      : [];
    const wsByid = new Map(wsRows.map((w) => [w.workspaceId, w]));

    const taskCountRows = workspaceIds.length > 0
      ? await db
          .select({ workspaceId: cuTasks.workspaceId, count: sql<number>`count(*)::int` })
          .from(cuTasks)
          .where(and(inArray(cuTasks.workspaceId, workspaceIds), isNull(cuTasks.deletedAt)))
          .groupBy(cuTasks.workspaceId)
      : [];
    const taskCountMap = new Map(taskCountRows.map((r) => [r.workspaceId, r.count]));

    const spaceCountRows = workspaceIds.length > 0
      ? await db
          .select({ workspaceId: cuSpaces.workspaceId, count: sql<number>`count(*)::int` })
          .from(cuSpaces)
          .where(and(inArray(cuSpaces.workspaceId, workspaceIds), isNull(cuSpaces.deletedAt)))
          .groupBy(cuSpaces.workspaceId)
      : [];
    const spaceCountMap = new Map(spaceCountRows.map((r) => [r.workspaceId, r.count]));

    const connections = rows.map((r) => {
      const ws = wsByid.get(r.workspaceId);
      return {
        workspaceId: r.workspaceId,
        name: ws?.name ?? null,
        pending: r.workspaceId.startsWith('pending-'),
        lastFullSyncAt: ws?.lastFullSyncAt ?? null,
        lastIncrementalSyncAt: ws?.lastIncrementalSyncAt ?? null,
        syncState: ws?.syncState ?? null,
        taskCount: taskCountMap.get(r.workspaceId) ?? 0,
        spaceCount: spaceCountMap.get(r.workspaceId) ?? 0,
      };
    });

    return c.json({
      connected: true,
      connections,
    });
  })
  .post('/sync-now', requireAuth, async (c) => {
    const u = c.get('user');
    const rows = await db
      .select({ workspaceId: clickupConnections.workspaceId })
      .from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)));
    if (rows.length === 0) return c.json({ error: 'not_connected' }, 400);
    // Run sync inline so the user gets a definitive done/error response.
    // For larger workspaces this can take minutes; the UI shows a spinner.
    try {
      const { runInitialSync } = await import('../sync/initial-sync.js');
      // Iterate every active workspace for this user. Not all may be ready
      // (placeholder ids); runInitialSync handles those.
      for (const r of rows) {
        await runInitialSync({ userId: u.id, workspaceId: r.workspaceId });
      }
      return c.json({ ok: true });
    } catch (err) {
      console.error('[sync-now] failed', err);
      return c.json({ error: String((err as Error).message ?? err) }, 500);
    }
  });

type Json = Record<string, unknown>;

/**
 * Enumerate every ClickUp workspace this access token has access to.
 * The MCP server returns one of two shapes when called with no args:
 *   - "Multiple workspaces available: <id1>, <id2>" error → parse ids
 *   - single-workspace hierarchy → extract its id
 * If both fail, returns []. Caller falls back to a placeholder row.
 */
async function enumerateWorkspaces(accessToken: string): Promise<string[]> {
  let session: Awaited<ReturnType<typeof openMcpSessionWithToken>> | null = null;
  try {
    session = await openMcpSessionWithToken(accessToken);

    let result: unknown;
    try {
      result = await session.client.callTool({
        name: 'clickup_get_workspace_hierarchy',
        arguments: {},
      });
    } catch (e) {
      console.warn('[clickup-oauth] enumerate: hierarchy call threw:', (e as Error).message);
      return [];
    }

    // Multi-workspace error path — the response carries isError + a text message
    // listing the available ids.
    const multi = parseMultiWorkspaceError(result);
    if (multi.length > 0) {
      console.log(`[clickup-oauth] enumerated ${multi.length} workspaces: ${multi.join(', ')}`);
      return multi;
    }

    // Single workspace path — the hierarchy returned successfully; extract the id.
    const single = extractWorkspaceId(result);
    if (single) {
      console.log(`[clickup-oauth] single workspace discovered: ${single}`);
      return [single];
    }

    // Fallback: scan resources.
    try {
      const resourcesResp = await session.client.listResources();
      for (const r of resourcesResp.resources) {
        const m = r.uri.match(/(?:workspace|team)[/_:](\d+)/i);
        if (m) return [m[1]!];
      }
    } catch { /* no resources */ }

    console.warn('[clickup-oauth] could not enumerate workspaces; raw:', JSON.stringify(result).slice(0, 500));
    return [];
  } finally {
    if (session) await session.close();
  }
}

function parseMultiWorkspaceError(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Json;
  if (!r.isError) return [];
  const text = Array.isArray(r.content)
    ? (r.content as Array<{ type?: string; text?: string }>).map((b) => b.text ?? '').join(' ')
    : '';
  const match = text.match(/Available workspaces?:\s*([\d,\s]+)/i);
  if (!match) return [];
  return match[1]!.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
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
  if (r.workspace && typeof r.workspace === 'object') {
    const ws = r.workspace as Record<string, unknown>;
    if (ws.id != null) return String(ws.id);
  }
  if (r.team && typeof r.team === 'object') {
    const t = r.team as Record<string, unknown>;
    if (t.id != null) return String(t.id);
  }
  // Newer hierarchy shape: { hierarchy: { root: { id, name, children: [...] } } }
  if (r.hierarchy && typeof r.hierarchy === 'object') {
    const h = r.hierarchy as Record<string, unknown>;
    if (h.root && typeof h.root === 'object') {
      const rt = h.root as Record<string, unknown>;
      if (rt.id != null) return String(rt.id);
    }
  }
  if (r.id != null && Array.isArray(r.spaces)) return String(r.id);
  if (r.id != null && typeof r.name === 'string' && String(r.id).match(/^\d+$/)) {
    return String(r.id);
  }

  if (Array.isArray(r.spaces) && r.spaces.length > 0) {
    const first = r.spaces[0] as Record<string, unknown>;
    const teamId = first.team_id ?? first.teamId ?? first.workspace_id ?? first.workspaceId;
    if (teamId != null) return String(teamId);
  }

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
