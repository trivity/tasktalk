import { TurnMcpPool, callMcpTool } from '../mcp/client.js';

export async function estimateWorkspaceSize(userId: string): Promise<{ approxTaskCount: number; listCount: number }> {
  const pool = new TurnMcpPool(userId);
  try {
    const session = await pool.get();
    const teamId = session.workspaceId;
    const spacesResp = await callMcpTool<{ spaces: Array<Record<string, unknown>> }>(session, 'list_spaces', { team_id: teamId });
    let listCount = 0;
    let sampledTasks = 0;
    let sampledLists = 0;
    for (const s of spacesResp.spaces ?? []) {
      const folders = await callMcpTool<{ folders: Array<Record<string, unknown>> }>(session, 'list_folders', { space_id: String(s.id) });
      for (const f of folders.folders ?? []) {
        for (const _l of (f.lists as Array<Record<string, unknown>> | undefined) ?? []) listCount++;
      }
      const folderless = await callMcpTool<{ lists: Array<Record<string, unknown>> }>(session, 'list_folderless_lists', { space_id: String(s.id) });
      for (const _l of folderless.lists ?? []) listCount++;

      // sample first 3 lists for per-list task counts
      const sample = [
        ...((folders.folders ?? []).flatMap((f) => (f.lists as Array<Record<string, unknown>> | undefined) ?? [])),
        ...(folderless.lists ?? []),
      ].slice(0, 3);
      for (const l of sample) {
        const tr = await callMcpTool<{ tasks: Array<unknown> }>(session, 'list_tasks', { list_id: String(l.id), page: 0 });
        sampledTasks += (tr.tasks ?? []).length;
        sampledLists++;
      }
    }
    const avg = sampledLists > 0 ? sampledTasks / sampledLists : 0;
    return { approxTaskCount: Math.round(avg * listCount), listCount };
  } finally {
    await pool.closeAll();
  }
}
