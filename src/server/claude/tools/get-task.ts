import { TurnMcpPool, callMcpTool } from '../../mcp/client.js';
import { upsertTask } from '../../sync/upsert.js';
import { db } from '../../db/client.js';
import { cuTasks } from '../../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';

export async function executeGetTask(workspaceIds: string[], taskId: string, pool: TurnMcpPool) {
  if (workspaceIds.length === 0) {
    return { data_source: 'live' as const, as_of: new Date().toISOString(), results: [], truncated: false };
  }

  // Resolve the owning workspace from the mirror first (fast path).
  // Falls back to trying the first workspace if the task isn't mirrored yet.
  const [mirrored] = await db
    .select({ workspaceId: cuTasks.workspaceId })
    .from(cuTasks)
    .where(and(eq(cuTasks.taskId, taskId), inArray(cuTasks.workspaceId, workspaceIds)))
    .limit(1);

  // Order: mirrored workspace first if known, then the rest.
  const order = mirrored
    ? [mirrored.workspaceId, ...workspaceIds.filter((w) => w !== mirrored.workspaceId)]
    : workspaceIds;

  const session = await pool.get();
  // get_task is workspace-scoped at the MCP layer. We attempt with each
  // workspace in turn — first hit wins. If the task simply doesn't exist,
  // every attempt errors out and we surface the last error.
  let lastErr: unknown = null;
  for (const wsId of order) {
    try {
      const resp = await callMcpTool<{ task: Record<string, unknown> }>(session, 'clickup_get_task', { task_id: taskId, workspace_id: wsId });
      if (resp?.task) {
        try { await upsertTask(wsId, resp.task); } catch { /* non-fatal */ }
        return {
          data_source: 'live' as const,
          as_of: new Date().toISOString(),
          results: [normalize(resp.task)],
          truncated: false,
        };
      }
    } catch (err) {
      lastErr = err;
      continue;
    }
  }
  if (lastErr) throw lastErr;
  return { data_source: 'live' as const, as_of: new Date().toISOString(), results: [], truncated: false };
}

function normalize(t: Record<string, unknown>) {
  return {
    task_id: String(t.id),
    name: String(t.name),
    description: t.description ? String(t.description) : null,
    status: (t.status as Record<string, unknown> | undefined)?.status ?? null,
    priority: typeof t.priority === 'object' && t.priority ? Number((t.priority as Record<string, unknown>).priority ?? 0) : (t.priority ?? null),
    due_date: t.due_date ? new Date(Number(t.due_date)).toISOString().slice(0, 10) : null,
    assignees: Array.isArray(t.assignees) ? (t.assignees as Array<Record<string, unknown>>).map((a) => ({ id: String(a.id), name: a.username ? String(a.username) : undefined })) : [],
    list_id: String((t.list as Record<string, unknown> | undefined)?.id ?? ''),
    tags: Array.isArray(t.tags) ? (t.tags as Array<Record<string, unknown>>).map((tg) => String(tg.name)) : [],
    recent_comments: Array.isArray(t.comments) ? (t.comments as Array<Record<string, unknown>>).slice(0, 5).map((cm) => ({ text: String((cm.comment_text as string | undefined) ?? ''), by: cm.user ? String((cm.user as Record<string, unknown>).username ?? '') : null })) : [],
  };
}
