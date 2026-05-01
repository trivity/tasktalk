import { db } from '../db/client.js';
import { cuWorkspaces } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';
import { upsertWorkspace, upsertSpace, upsertFolder, upsertList, upsertTask, upsertMember, upsertCustomField } from './upsert.js';
import { pacerForRateLimit } from './pacing.js';
import type { InitialSyncPayload } from './boss.js';

const PACE_CALLS_PER_24H = Number(process.env.SYNC_RATE_LIMIT ?? 300);

export async function runInitialSync({ userId }: InitialSyncPayload): Promise<void> {
  const pool = new TurnMcpPool(userId);
  const session = await pool.get();
  const workspaceId = session.workspaceId;
  const pacer = pacerForRateLimit(PACE_CALLS_PER_24H);

  try {
    await upsertWorkspace(workspaceId, '(syncing…)');
    await db.update(cuWorkspaces).set({ syncState: { phase: 'spaces' } }).where(eq(cuWorkspaces.workspaceId, workspaceId));

    // 1. Spaces
    await pacer.acquire();
    const spacesResp = await callMcpTool<{ spaces: Array<Record<string, unknown>> }>(session, 'list_spaces', { team_id: workspaceId });
    for (const s of spacesResp.spaces ?? []) await upsertSpace(workspaceId, s);

    // 2. Folders + lists per space
    let listsTotal = 0; let listsDone = 0;
    const allLists: string[] = [];
    for (const s of spacesResp.spaces ?? []) {
      const sid = String(s.id);
      await pacer.acquire();
      const foldersResp = await callMcpTool<{ folders: Array<Record<string, unknown>> }>(session, 'list_folders', { space_id: sid });
      for (const f of foldersResp.folders ?? []) {
        await upsertFolder(workspaceId, f);
        for (const l of (f.lists as Array<Record<string, unknown>> | undefined) ?? []) {
          await upsertList(workspaceId, l);
          allLists.push(String(l.id));
          listsTotal++;
        }
      }
      await pacer.acquire();
      const folderlessResp = await callMcpTool<{ lists: Array<Record<string, unknown>> }>(session, 'list_folderless_lists', { space_id: sid });
      for (const l of folderlessResp.lists ?? []) {
        await upsertList(workspaceId, l);
        allLists.push(String(l.id));
        listsTotal++;
      }
    }
    await db.update(cuWorkspaces).set({ syncState: { phase: 'tasks', listsDone: 0, listsTotal } }).where(eq(cuWorkspaces.workspaceId, workspaceId));

    // 3. Tasks + custom fields per list (paginated)
    for (const listId of allLists) {
      // custom field defs (one call per list)
      await pacer.acquire();
      try {
        const cfResp = await callMcpTool<{ fields: Array<Record<string, unknown>> }>(session, 'list_custom_fields', { list_id: listId });
        for (const f of cfResp.fields ?? []) await upsertCustomField(workspaceId, listId, 'list', f);
      } catch { /* not all lists have cf endpoint */ }

      // tasks
      let page = 0;
      while (true) {
        await pacer.acquire();
        const resp = await callMcpTool<{ tasks: Array<Record<string, unknown>>; last_page?: boolean }>(session, 'list_tasks', { list_id: listId, page, include_subtasks: true });
        for (const t of resp.tasks ?? []) await upsertTask(workspaceId, t);
        if (!resp.tasks?.length || resp.last_page) break;
        page++;
      }
      listsDone++;
      if (listsDone % 5 === 0) {
        await db.update(cuWorkspaces).set({ syncState: { phase: 'tasks', listsDone, listsTotal } }).where(eq(cuWorkspaces.workspaceId, workspaceId));
      }
    }

    // 4. Members
    await pacer.acquire();
    const teamResp = await callMcpTool<{ team: { members: Array<Record<string, unknown>> } }>(session, 'get_team', { team_id: workspaceId });
    for (const m of teamResp.team?.members ?? []) await upsertMember(workspaceId, m);

    // 5. Mark complete
    const now = new Date();
    await db.update(cuWorkspaces)
      .set({ lastFullSyncAt: now, lastIncrementalSyncAt: now, syncState: { phase: 'done', listsDone, listsTotal } })
      .where(eq(cuWorkspaces.workspaceId, workspaceId));
  } finally {
    await pool.closeAll();
  }
}
