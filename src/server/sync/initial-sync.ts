import { db } from '../db/client.js';
import { cuWorkspaces, clickupConnections } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';
import {
  upsertWorkspace, upsertSpace, upsertFolder, upsertList,
  upsertTask, upsertMember, upsertCustomField,
} from './upsert.js';
import { pacerForRateLimit } from './pacing.js';
import type { InitialSyncPayload } from './boss.js';

const PACE_CALLS_PER_24H = Number(process.env.SYNC_RATE_LIMIT ?? 300);

type Json = Record<string, unknown>;

/**
 * Unwrap an MCP tool response. ClickUp's MCP server may return either a
 * direct JSON object OR the standard MCP envelope:
 *   { content: [{ type: 'text', text: '<json>' }], ... }
 * We try the envelope path first, then fall back to the raw value.
 */
function unwrapMcp(resp: unknown): unknown {
  if (!resp || typeof resp !== 'object') return resp;
  const r = resp as Json;
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      const b = block as Json | null;
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        try {
          return JSON.parse(b.text);
        } catch {
          /* not JSON; keep looking */
        }
      }
      if (b.type === 'resource' && b.resource && typeof b.resource === 'object') {
        return b.resource;
      }
    }
  }
  return resp;
}

function asArray(value: unknown): Json[] {
  if (Array.isArray(value)) return value as Json[];
  return [];
}

/**
 * The ClickUp MCP `clickup_get_workspace_hierarchy` response shape isn't
 * formally documented locally. We've seen plausible variants in the wild:
 *   - { workspace: { id, name }, spaces: [{ id, name, folders: [...], lists: [...] }] }
 *   - { team: { id, name }, spaces: [...] }
 *   - { id, name, spaces: [...] }
 *   - MCP envelope: { content: [{ type:'text', text:'<json above>' }] }
 * We probe each shape; if none match, we log the raw blob for diagnosis and
 * return an empty hierarchy so the caller can continue with a partial sync.
 */
type ParsedHierarchy = {
  workspaceId: string | null;
  workspaceName: string | null;
  spaces: Array<{
    id: string;
    name: string;
    archived: boolean;
    folders: Array<{
      id: string;
      name: string;
      archived: boolean;
      space_id: string;
      lists: Json[];
    }>;
    lists: Json[]; // folderless lists
  }>;
};

function parseHierarchy(rawResp: unknown): ParsedHierarchy {
  const unwrapped = unwrapMcp(rawResp);
  const root = (unwrapped && typeof unwrapped === 'object' ? (unwrapped as Json) : {}) as Json;

  // ClickUp's MCP returns: { hierarchy: { root: { id, name, children: [...] } } }
  // where children carry a `type` discriminator: 'space' | 'folder' | 'list'.
  // The workspace itself is the `root` node (no type).
  const hierarchy = (root.hierarchy && typeof root.hierarchy === 'object' ? (root.hierarchy as Json) : null);
  const treeRoot: Json | null = (() => {
    if (hierarchy && hierarchy.root && typeof hierarchy.root === 'object') return hierarchy.root as Json;
    if (root.root && typeof root.root === 'object') return root.root as Json;
    return null;
  })();

  // Try the new "discriminated children tree" shape first.
  if (treeRoot) {
    const wsId = treeRoot.id != null ? String(treeRoot.id) : null;
    const wsName = typeof treeRoot.name === 'string' ? treeRoot.name : null;
    const spaceNodes = asArray(treeRoot.children).filter((c) => c.type === 'space');
    const spaces = spaceNodes.map((s) => {
      const spaceId = String(s.id ?? '');
      const spaceName = typeof s.name === 'string' ? s.name : '(unnamed)';
      const archived = Boolean(s.archived);
      const children = asArray(s.children);
      const folders = children
        .filter((c) => c.type === 'folder')
        .map((f) => {
          const folderId = String(f.id ?? '');
          const folderName = typeof f.name === 'string' ? f.name : '(unnamed)';
          const folderArchived = Boolean(f.archived);
          const lists = asArray(f.children)
            .filter((c) => c.type === 'list')
            .map((l) => ({ ...l, id: l.id, name: l.name } as Json));
          return { id: folderId, name: folderName, archived: folderArchived, space_id: spaceId, lists };
        });
      const folderlessLists = children.filter((c) => c.type === 'list').map((l) => ({ ...l } as Json));
      return { id: spaceId, name: spaceName, archived, folders, lists: folderlessLists };
    });
    return { workspaceId: wsId, workspaceName: wsName, spaces };
  }

  // Fallbacks for other plausible shapes (kept as defense-in-depth).
  let wsId: string | null = null;
  let wsName: string | null = null;
  if (root.workspace && typeof root.workspace === 'object') {
    const w = root.workspace as Json;
    if (w.id != null) wsId = String(w.id);
    if (typeof w.name === 'string') wsName = w.name;
  } else if (root.team && typeof root.team === 'object') {
    const t = root.team as Json;
    if (t.id != null) wsId = String(t.id);
    if (typeof t.name === 'string') wsName = t.name;
  } else if (root.id != null) {
    wsId = String(root.id);
    if (typeof root.name === 'string') wsName = root.name;
  }

  const spaceCandidates: unknown[] = [
    root.spaces,
    (root.workspace as Json | undefined)?.spaces,
    (root.team as Json | undefined)?.spaces,
  ];
  let rawSpaces: Json[] = [];
  for (const c of spaceCandidates) {
    if (Array.isArray(c) && c.length > 0) { rawSpaces = c as Json[]; break; }
  }
  if (!wsId && rawSpaces.length > 0) {
    const first = rawSpaces[0]!;
    const tid = first.team_id ?? first.workspace_id ?? first.teamId ?? first.workspaceId;
    if (tid != null) wsId = String(tid);
  }
  const spaces = rawSpaces.map((s) => {
    const spaceId = String(s.id ?? '');
    const spaceName = typeof s.name === 'string' ? s.name : '(unnamed)';
    const archived = Boolean(s.archived);
    const rawFolders = asArray(s.folders);
    const folders = rawFolders.map((f) => ({
      id: String(f.id ?? ''),
      name: typeof f.name === 'string' ? f.name : '(unnamed)',
      archived: Boolean(f.archived),
      space_id: spaceId,
      lists: asArray(f.lists),
    }));
    const folderless = asArray(
      (s.lists as unknown) ?? (s.folderless_lists as unknown) ?? (s.folderlessLists as unknown),
    );
    return { id: spaceId, name: spaceName, archived, folders, lists: folderless };
  });

  return { workspaceId: wsId, workspaceName: wsName, spaces };
}

/**
 * Best-effort extraction of an array of "items" from any tool that may return
 * a list — it could be { fields: [...] }, { tasks: [...] }, { members: [...] },
 * a bare array, or wrapped in the MCP envelope.
 */
function extractItems(resp: unknown, ...keys: string[]): Json[] {
  const unwrapped = unwrapMcp(resp);
  if (Array.isArray(unwrapped)) return unwrapped as Json[];
  if (!unwrapped || typeof unwrapped !== 'object') return [];
  const r = unwrapped as Json;
  for (const k of keys) {
    if (Array.isArray(r[k])) return r[k] as Json[];
  }
  return [];
}

function extractLastPage(resp: unknown): boolean {
  const unwrapped = unwrapMcp(resp);
  if (!unwrapped || typeof unwrapped !== 'object') return false;
  const r = unwrapped as Json;
  return Boolean(r.last_page);
}

function logPartial(label: string, err: unknown, raw?: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[initial-sync] ${label}: ${msg}`);
  if (raw !== undefined) {
    try {
      console.warn(`[initial-sync] ${label} raw:`, JSON.stringify(raw).slice(0, 1000));
    } catch {
      /* unserialisable */
    }
  }
}

export async function runInitialSync({ userId }: InitialSyncPayload): Promise<void> {
  const pool = new TurnMcpPool(userId);
  const session = await pool.get();
  let workspaceId = session.workspaceId;
  const pacer = pacerForRateLimit(PACE_CALLS_PER_24H);

  try {
    // 1. Workspace hierarchy — single call replaces list_spaces / list_folders /
    //    list_folderless_lists. Args: probe with workspace_id when we already
    //    have a real one; fall back to no-arg call for placeholder ids.
    await pacer.acquire();
    const hierArgs: Record<string, unknown> = {};
    if (!workspaceId.startsWith('pending-')) hierArgs.workspace_id = workspaceId;
    let rawHierarchy: unknown = null;
    try {
      rawHierarchy = await callMcpTool(session, 'clickup_get_workspace_hierarchy', hierArgs);
    } catch (err) {
      // If the server rejected workspace_id (e.g. tool takes no args), retry empty.
      logPartial('clickup_get_workspace_hierarchy initial call failed; retrying with empty args', err);
      try {
        rawHierarchy = await callMcpTool(session, 'clickup_get_workspace_hierarchy', {});
      } catch (err2) {
        logPartial('clickup_get_workspace_hierarchy fully failed; aborting', err2);
        throw err2;
      }
    }

    const parsed = parseHierarchy(rawHierarchy);
    if (parsed.workspaceId == null) {
      logPartial('parseHierarchy could not extract workspace_id', new Error('no workspace_id in response'), rawHierarchy);
    }

    // Resolve placeholder workspace_id from hierarchy if needed.
    if (workspaceId.startsWith('pending-') && parsed.workspaceId) {
      const realWsId = parsed.workspaceId;
      console.log(`[initial-sync] resolved placeholder workspace_id → ${realWsId} for user ${userId}`);
      await db
        .update(clickupConnections)
        .set({ workspaceId: realWsId })
        .where(eq(clickupConnections.userId, userId));
      workspaceId = realWsId;
      // Update session.workspaceId in-place so any downstream callMcpTool args using
      // session.workspaceId pick up the real id (TurnMcpPool re-uses a single session).
      (session as unknown as { workspaceId: string }).workspaceId = realWsId;
    }

    const wsName = parsed.workspaceName ?? '(syncing…)';
    await upsertWorkspace(workspaceId, wsName);
    await db.update(cuWorkspaces).set({ syncState: { phase: 'spaces' } }).where(eq(cuWorkspaces.workspaceId, workspaceId));

    // 2. Walk hierarchy: spaces → folders → lists. The hierarchy already
    //    contains all of them, so no extra MCP calls needed for structure.
    const allLists: string[] = [];
    let listsTotal = 0;
    for (const space of parsed.spaces) {
      // upsertSpace expects { id, name, archived }
      try {
        await upsertSpace(workspaceId, { id: space.id, name: space.name, archived: space.archived });
      } catch (err) {
        logPartial(`upsertSpace ${space.id}`, err);
        continue;
      }
      for (const folder of space.folders) {
        try {
          await upsertFolder(workspaceId, {
            id: folder.id,
            name: folder.name,
            archived: folder.archived,
            space: { id: space.id },
          });
        } catch (err) {
          logPartial(`upsertFolder ${folder.id}`, err);
        }
        for (const list of folder.lists) {
          try {
            const listPayload: Json = {
              ...list,
              space: list.space ?? { id: space.id },
              folder: list.folder ?? { id: folder.id },
            };
            await upsertList(workspaceId, listPayload);
            allLists.push(String(list.id));
            listsTotal++;
          } catch (err) {
            logPartial(`upsertList ${String(list.id)}`, err);
          }
        }
      }
      for (const list of space.lists) {
        try {
          const listPayload: Json = {
            ...list,
            space: list.space ?? { id: space.id },
            folder: undefined,
          };
          await upsertList(workspaceId, listPayload);
          allLists.push(String(list.id));
          listsTotal++;
        } catch (err) {
          logPartial(`upsertList (folderless) ${String(list.id)}`, err);
        }
      }
    }

    await db
      .update(cuWorkspaces)
      .set({ syncState: { phase: 'tasks', listsDone: 0, listsTotal } })
      .where(eq(cuWorkspaces.workspaceId, workspaceId));

    // 3. Members
    await pacer.acquire();
    try {
      const membersResp = await callMcpTool(session, 'clickup_get_workspace_members', { workspace_id: workspaceId });
      const members = extractItems(membersResp, 'members', 'team_members', 'users');
      // some shapes return { team: { members: [...] } }
      const teamMembers = (() => {
        if (members.length > 0) return members;
        const unwrapped = unwrapMcp(membersResp);
        const team = (unwrapped && typeof unwrapped === 'object' ? (unwrapped as Json).team : undefined) as Json | undefined;
        if (team && Array.isArray(team.members)) return team.members as Json[];
        return [];
      })();
      for (const m of teamMembers) {
        try { await upsertMember(workspaceId, m); } catch (err) { logPartial('upsertMember', err); }
      }
    } catch (err) {
      logPartial('clickup_get_workspace_members', err);
    }

    // 4. Custom fields per list, then tasks per list (paginated).
    let listsDone = 0;
    for (const listId of allLists) {
      // Custom field defs.
      await pacer.acquire();
      try {
        const cfResp = await callMcpTool(session, 'clickup_get_custom_fields', { list_id: listId });
        const fields = extractItems(cfResp, 'fields', 'custom_fields');
        for (const f of fields) {
          try { await upsertCustomField(workspaceId, listId, 'list', f); } catch (err) { logPartial('upsertCustomField', err); }
        }
      } catch (err) {
        // not all lists expose custom-field defs; never fail the whole sync over this
        logPartial(`clickup_get_custom_fields list=${listId}`, err);
      }

      // Tasks (paginated).
      let page = 0;
      // soft cap to keep us out of pathological infinite loops if server doesn't honor last_page
      const MAX_PAGES = 200;
      while (page < MAX_PAGES) {
        await pacer.acquire();
        let resp: unknown;
        try {
          resp = await callMcpTool(session, 'clickup_filter_tasks', {
            workspace_id: workspaceId,
            list_id: listId,
            page,
            include_subtasks: true,
          });
        } catch (err) {
          logPartial(`clickup_filter_tasks list=${listId} page=${page}`, err);
          break;
        }
        const tasks = extractItems(resp, 'tasks');
        for (const t of tasks) {
          try { await upsertTask(workspaceId, t); } catch (err) { logPartial(`upsertTask ${String(t.id)}`, err); }
        }
        const last = extractLastPage(resp);
        if (tasks.length === 0 || last) break;
        page++;
      }
      listsDone++;
      if (listsDone % 5 === 0) {
        await db
          .update(cuWorkspaces)
          .set({ syncState: { phase: 'tasks', listsDone, listsTotal } })
          .where(eq(cuWorkspaces.workspaceId, workspaceId));
      }
    }

    // 5. Mark complete.
    const now = new Date();
    await db
      .update(cuWorkspaces)
      .set({ lastFullSyncAt: now, lastIncrementalSyncAt: now, syncState: { phase: 'done', listsDone, listsTotal } })
      .where(eq(cuWorkspaces.workspaceId, workspaceId));
  } finally {
    await pool.closeAll();
  }
}
