import { TurnMcpPool, callMcpTool } from '../mcp/client.js';

type Json = Record<string, unknown>;

function unwrapMcp(resp: unknown): unknown {
  if (!resp || typeof resp !== 'object') return resp;
  const r = resp as Json;
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      const b = block as Json | null;
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        try { return JSON.parse(b.text); } catch { /* not JSON */ }
      }
    }
  }
  return resp;
}

function asArray(v: unknown): Json[] { return Array.isArray(v) ? (v as Json[]) : []; }

export async function estimateWorkspaceSize(userId: string): Promise<{ approxTaskCount: number; listCount: number }> {
  const pool = new TurnMcpPool(userId);
  try {
    const session = await pool.get();
    const workspaceId = session.workspaceId;

    // Single hierarchy call replaces list_spaces / list_folders / list_folderless_lists.
    const hierArgs: Record<string, unknown> = {};
    if (!workspaceId.startsWith('pending-')) hierArgs.workspace_id = workspaceId;
    let raw: unknown;
    try {
      raw = await callMcpTool(session, 'clickup_get_workspace_hierarchy', hierArgs);
    } catch {
      try { raw = await callMcpTool(session, 'clickup_get_workspace_hierarchy', {}); }
      catch { return { approxTaskCount: 0, listCount: 0 }; }
    }
    const root = (unwrapMcp(raw) ?? {}) as Json;
    const allListIds: string[] = [];

    // Primary shape: { hierarchy: { root: { id, children: [{ type: 'space', children: [...] }] } } }
    const hierarchy = (root.hierarchy && typeof root.hierarchy === 'object' ? (root.hierarchy as Json) : null);
    const treeRoot: Json | null = hierarchy && (hierarchy.root as Json | undefined)
      ? (hierarchy.root as Json)
      : (root.root as Json | undefined) ?? null;

    if (treeRoot) {
      const spaceNodes = asArray(treeRoot.children).filter((c) => c.type === 'space');
      for (const s of spaceNodes) {
        const children = asArray(s.children);
        // folderless lists
        for (const l of children) {
          if (l.type === 'list' && l.id != null) allListIds.push(String(l.id));
        }
        // folder lists
        for (const f of children) {
          if (f.type !== 'folder') continue;
          for (const l of asArray(f.children)) {
            if (l.type === 'list' && l.id != null) allListIds.push(String(l.id));
          }
        }
      }
    } else {
      // Fallback flat-spaces shape
      const spaces = asArray(
        root.spaces ?? (root.workspace as Json | undefined)?.spaces ?? (root.team as Json | undefined)?.spaces,
      );
      for (const s of spaces) {
        const folders = asArray(s.folders);
        for (const f of folders) {
          for (const l of asArray(f.lists)) {
            if (l.id != null) allListIds.push(String(l.id));
          }
        }
        const folderless = asArray(s.lists ?? s.folderless_lists);
        for (const l of folderless) {
          if (l.id != null) allListIds.push(String(l.id));
        }
      }
    }
    const listCount = allListIds.length;

    // Sample up to 3 lists for an average task count per list.
    const sample = allListIds.slice(0, 3);
    let sampledTasks = 0;
    let sampledLists = 0;
    for (const listId of sample) {
      try {
        const tr = await callMcpTool(session, 'clickup_filter_tasks', {
          workspace_id: workspaceId,
          list_id: listId,
          page: 0,
        });
        const tasks = ((): Json[] => {
          const u = unwrapMcp(tr);
          if (!u || typeof u !== 'object') return [];
          return asArray((u as Json).tasks);
        })();
        sampledTasks += tasks.length;
        sampledLists++;
      } catch { /* skip; estimate is best-effort */ }
    }
    const avg = sampledLists > 0 ? sampledTasks / sampledLists : 0;
    return { approxTaskCount: Math.round(avg * listCount), listCount };
  } finally {
    await pool.closeAll();
  }
}
