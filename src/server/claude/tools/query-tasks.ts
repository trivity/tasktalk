import { db } from '../../db/client.js';
import { cuWorkspaces, cuTasks, cuLists } from '../../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { querySnapshot, type TaskFilters } from '../../db/queries/tasks.js';
import { decideRoute } from '../router.js';
import type { TurnMcpPool } from '../../mcp/client.js';
import { callMcpTool } from '../../mcp/client.js';
import { upsertTask } from '../../sync/upsert.js';
import { getBoss, QUEUE_DRIFT } from '../../sync/boss.js';
import type { QueryTasksArgs, NormalizedReadResult } from '../../../shared/schemas/tools.js';

export async function executeQueryTasks(
  workspaceIds: string[],
  args: QueryTasksArgs,
  pool: TurnMcpPool,
): Promise<NormalizedReadResult> {
  if (workspaceIds.length === 0) {
    return { data_source: 'snapshot', as_of: new Date(0).toISOString(), results: [], truncated: false };
  }
  const wsRows = await db
    .select({ workspaceId: cuWorkspaces.workspaceId, lastSyncAt: cuWorkspaces.lastIncrementalSyncAt })
    .from(cuWorkspaces)
    .where(inArray(cuWorkspaces.workspaceId, workspaceIds));
  // Oldest as_of for staleness reasoning.
  const oldestSync = wsRows.reduce<Date | null>((acc, r) => {
    const t = r.lastSyncAt ?? new Date(0);
    if (acc === null) return t;
    return t.getTime() < acc.getTime() ? t : acc;
  }, null);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cuTasks)
    .where(inArray(cuTasks.workspaceId, workspaceIds));
  const count = countRows[0]?.count ?? 0;
  const route = decideRoute({ lastSyncAt: oldestSync, mirrorEmpty: count === 0 });

  const filters: TaskFilters = {
    listId: args.list_id,
    status: args.status,
    assigneeId: args.assignee_id,
    dueBefore: args.due_before,
    dueAfter: args.due_after,
    hasTag: args.has_tag,
  };

  if (route === 'snapshot') {
    return await querySnapshot({ workspaceIds, filters });
  }

  if (route === 'live' || route === 'live-first-run') {
    // Live MCP needs a single workspace_id. Resolve from list_id when given,
    // else fall back to the first workspace.
    let liveWorkspaceId = workspaceIds[0]!;
    if (args.list_id) {
      const [listRow] = await db
        .select({ workspaceId: cuLists.workspaceId })
        .from(cuLists)
        .where(eq(cuLists.id, args.list_id))
        .limit(1);
      if (listRow && workspaceIds.includes(listRow.workspaceId)) {
        liveWorkspaceId = listRow.workspaceId;
      }
    }

    try {
      const session = await pool.get();
      const liveResult = await callMcpTool<{ tasks: Array<Record<string, unknown>> }>(
        session,
        'clickup_filter_tasks',
        mcpFiltersFor(liveWorkspaceId, args),
      );
      const liveTasks = liveResult.tasks ?? [];

      if (liveTasks.length === 0 && route === 'live') {
        const fallback = await querySnapshot({ workspaceIds, filters });
        if (fallback.results.length > 0) {
          return { ...fallback, data_source: 'snapshot · live-fallback', fallback_reason: 'live returned empty' };
        }
      }

      for (const t of liveTasks) {
        try { await upsertTask(liveWorkspaceId, t); } catch { /* non-fatal */ }
      }
      if (route === 'live') {
        const boss = await getBoss();
        await boss.send(QUEUE_DRIFT, { workspaceId: liveWorkspaceId });
      }
      return {
        data_source: 'live',
        as_of: new Date().toISOString(),
        results: liveTasks.map(normalizeTask),
        truncated: false,
        first_run: route === 'live-first-run',
      };
    } catch (err) {
      const reason = String((err as Error).message ?? err);
      const fallback = await querySnapshot({ workspaceIds, filters });
      return { ...fallback, data_source: 'snapshot · live-fallback', fallback_reason: reason };
    }
  }

  return await querySnapshot({ workspaceIds, filters });
}

function mcpFiltersFor(workspaceId: string, args: QueryTasksArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.workspace_id = workspaceId;
  if (args.list_id) out.list_id = args.list_id;
  if (args.status) out.statuses = args.status;
  if (args.assignee_id) out.assignees = String(args.assignee_id);
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
