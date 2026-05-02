import { TurnMcpPool, callMcpTool } from '../../mcp/client.js';
import { upsertTask } from '../../sync/upsert.js';

export async function executeGetTask(workspaceId: string, taskId: string, pool: TurnMcpPool) {
  const session = await pool.get();
  const resp = await callMcpTool<{ task: Record<string, unknown> }>(session, 'clickup_get_task', { task_id: taskId });
  if (resp?.task) {
    try { await upsertTask(workspaceId, resp.task); } catch { /* non-fatal cache-back */ }
  }
  return {
    data_source: 'live' as const,
    as_of: new Date().toISOString(),
    results: resp?.task ? [normalize(resp.task)] : [],
    truncated: false,
  };
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
