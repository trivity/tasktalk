import { db } from '../../db/client.js';
import { cuWorkspaces, cuTasks } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { querySnapshot, type TaskFilters } from '../../db/queries/tasks.js';
import { decideRoute } from '../router.js';
import type { TurnMcpPool } from '../../mcp/client.js';
import { callMcpTool } from '../../mcp/client.js';
import { upsertTask } from '../../sync/upsert.js';
import { getBoss, QUEUE_DRIFT } from '../../sync/boss.js';
import type { QueryTasksArgs, NormalizedReadResult } from '../../../shared/schemas/tools.js';

export async function executeQueryTasks(
  workspaceId: string,
  args: QueryTasksArgs,
  pool: TurnMcpPool,
): Promise<NormalizedReadResult> {
  const [ws] = await db
    .select({ lastSyncAt: cuWorkspaces.lastIncrementalSyncAt })
    .from(cuWorkspaces)
    .where(eq(cuWorkspaces.workspaceId, workspaceId))
    .limit(1);
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cuTasks)
    .where(and(eq(cuTasks.workspaceId, workspaceId)));
  const count = countRows[0]?.count ?? 0;
  const route = decideRoute({ lastSyncAt: ws?.lastSyncAt ?? null, mirrorEmpty: count === 0 });

  const filters: TaskFilters = {
    listId: args.list_id,
    status: args.status,
    assigneeId: args.assignee_id,
    dueBefore: args.due_before,
    dueAfter: args.due_after,
    hasTag: args.has_tag,
  };

  if (route === 'snapshot') {
    return await querySnapshot({ workspaceId, filters });
  }

  if (route === 'live' || route === 'live-first-run') {
    try {
      const session = await pool.get();
      const liveResult = await callMcpTool<{ tasks: Array<Record<string, unknown>> }>(
        session,
        'list_tasks',
        mcpFiltersFor(args),
      );
      // best-effort cache-back
      for (const t of liveResult.tasks ?? []) {
        try { await upsertTask(workspaceId, t); } catch { /* non-fatal */ }
      }
      // queue a sync for next time
      if (route === 'live') {
        const boss = await getBoss();
        await boss.send(QUEUE_DRIFT, { workspaceId });
      }
      return {
        data_source: 'live',
        as_of: new Date().toISOString(),
        results: (liveResult.tasks ?? []).map(normalizeTask),
        truncated: false,
        first_run: route === 'live-first-run',
      };
    } catch (err) {
      const reason = String((err as Error).message ?? err);
      const fallback = await querySnapshot({ workspaceId, filters });
      return { ...fallback, data_source: 'snapshot · live-fallback', fallback_reason: reason };
    }
  }

  return await querySnapshot({ workspaceId, filters });
}

function mcpFiltersFor(args: QueryTasksArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.list_id) out.list_id = args.list_id;
  if (args.status) out.statuses = args.status;
  if (args.assignee_id) out.assignees = [args.assignee_id];
  if (args.due_before) out.due_date_lt = new Date(args.due_before).getTime();
  if (args.due_after) out.due_date_gt = new Date(args.due_after).getTime();
  return out;
}

function normalizeTask(t: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: String(t.id),
    name: String(t.name),
    status: (t.status as Record<string, unknown> | undefined)?.status ?? null,
    priority: typeof t.priority === 'object' && t.priority
      ? Number((t.priority as Record<string, unknown>).priority ?? 0)
      : (t.priority ?? null),
    due_date: t.due_date ? new Date(Number(t.due_date)).toISOString().slice(0, 10) : null,
    assignees: Array.isArray(t.assignees)
      ? (t.assignees as Array<Record<string, unknown>>).map((a) => ({ id: String(a.id), name: a.username ? String(a.username) : undefined }))
      : [],
    list_id: String((t.list as Record<string, unknown> | undefined)?.id ?? ''),
    tags: Array.isArray(t.tags)
      ? (t.tags as Array<Record<string, unknown>>).map((tg) => String(tg.name))
      : [],
  };
}
