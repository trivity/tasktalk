import { db } from '../client.js';
import { cuTasks, cuWorkspaces } from '../schema.js';
import { and, eq, gte, lte, isNull, sql, type SQL, inArray } from 'drizzle-orm';

export type TaskFilters = {
  listId?: string;
  status?: string[];
  assigneeId?: string;
  dueBefore?: string; // YYYY-MM-DD
  dueAfter?: string;
  hasTag?: string;
};

export type SnapshotResult = {
  data_source: 'snapshot';
  as_of: string;
  results: Array<{
    task_id: string;
    name: string;
    status: string | null;
    priority: number | null;
    due_date: string | null;
    assignees: Array<{ id: string; name?: string }>;
    list_id: string;
    tags: string[];
  }>;
  truncated: boolean;
  total_estimate: number;
};

const MAX_RESULTS = 200;

export async function querySnapshot(opts: { workspaceId: string; filters: TaskFilters }): Promise<SnapshotResult> {
  const { workspaceId, filters } = opts;
  const conds: SQL[] = [eq(cuTasks.workspaceId, workspaceId), isNull(cuTasks.deletedAt)];
  if (filters.listId) conds.push(eq(cuTasks.listId, filters.listId));
  if (filters.status?.length) conds.push(inArray(cuTasks.status, filters.status) as SQL);
  if (filters.assigneeId) conds.push(sql`${cuTasks.assignees} @> ${JSON.stringify([{ id: filters.assigneeId }])}::jsonb`);
  if (filters.dueBefore) conds.push(lte(cuTasks.dueDate, filters.dueBefore));
  if (filters.dueAfter) conds.push(gte(cuTasks.dueDate, filters.dueAfter));
  if (filters.hasTag) conds.push(sql`${cuTasks.tags} @> ${JSON.stringify([filters.hasTag])}::jsonb`);

  const rows = await db.select().from(cuTasks).where(and(...conds)).limit(MAX_RESULTS + 1);
  const truncated = rows.length > MAX_RESULTS;
  const slice = rows.slice(0, MAX_RESULTS);

  const [ws] = await db
    .select({ asOf: cuWorkspaces.lastIncrementalSyncAt })
    .from(cuWorkspaces)
    .where(eq(cuWorkspaces.workspaceId, workspaceId))
    .limit(1);

  return {
    data_source: 'snapshot',
    as_of: (ws?.asOf ?? new Date(0)).toISOString(),
    results: slice.map((r) => ({
      task_id: r.taskId,
      name: r.name,
      status: r.status,
      priority: r.priority,
      due_date: r.dueDate,
      assignees: r.assignees,
      list_id: r.listId,
      tags: r.tags,
    })),
    truncated,
    total_estimate: rows.length,
  };
}
