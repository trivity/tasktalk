import { db } from '../client.js';
import { cuTasks, cuWorkspaces } from '../schema.js';
import { and, gte, lte, isNull, or, sql, type SQL, inArray } from 'drizzle-orm';

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

/**
 * Query the mirror snapshot across one or more workspaces. Result `as_of` is
 * the OLDEST `last_incremental_sync_at` among the queried workspaces, so the
 * caller sees the worst-case staleness.
 */
export async function querySnapshot(opts: { workspaceIds: string[]; filters: TaskFilters }): Promise<SnapshotResult> {
  const { workspaceIds, filters } = opts;
  if (workspaceIds.length === 0) {
    return {
      data_source: 'snapshot',
      as_of: new Date(0).toISOString(),
      results: [],
      truncated: false,
      total_estimate: 0,
    };
  }

  const conds: SQL[] = [inArray(cuTasks.workspaceId, workspaceIds), isNull(cuTasks.deletedAt)];
  if (filters.listId) conds.push(sql`${cuTasks.listId} = ${filters.listId}`);
  if (filters.status?.length) {
    // Mirror has many tasks with NULL status. Aggregate query treats NULL as
    // open. Match that here: when caller asks for any open-like status, also
    // include NULL rows. Only exclude NULL when the filter is purely closed.
    const closedStatuses = ['closed', 'done', 'cancelled', 'complete', 'completed', 'archived'];
    const wantsOpenLike = filters.status.some((s) => !closedStatuses.includes(s.toLowerCase()));
    conds.push(
      wantsOpenLike
        ? (or(inArray(cuTasks.status, filters.status), isNull(cuTasks.status)) as SQL)
        : (inArray(cuTasks.status, filters.status) as SQL),
    );
  }
  if (filters.assigneeId) conds.push(sql`${cuTasks.assignees} @> ${JSON.stringify([{ id: filters.assigneeId }])}::jsonb`);
  if (filters.dueBefore) conds.push(lte(cuTasks.dueDate, filters.dueBefore));
  if (filters.dueAfter) conds.push(gte(cuTasks.dueDate, filters.dueAfter));
  if (filters.hasTag) conds.push(sql`${cuTasks.tags} @> ${JSON.stringify([filters.hasTag])}::jsonb`);

  const rows = await db.select().from(cuTasks).where(and(...conds)).limit(MAX_RESULTS + 1);
  const truncated = rows.length > MAX_RESULTS;
  const slice = rows.slice(0, MAX_RESULTS);

  const wsRows = await db
    .select({ asOf: cuWorkspaces.lastIncrementalSyncAt })
    .from(cuWorkspaces)
    .where(inArray(cuWorkspaces.workspaceId, workspaceIds));
  // Pick the OLDEST as_of (worst-case staleness). If any has never synced
  // (null), treat as epoch.
  const oldest = wsRows.reduce<Date>((acc, r) => {
    const t = r.asOf ?? new Date(0);
    return t.getTime() < acc.getTime() ? t : acc;
  }, new Date());

  return {
    data_source: 'snapshot',
    as_of: oldest.toISOString(),
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
