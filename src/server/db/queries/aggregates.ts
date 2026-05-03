import { db } from '../client.js';
import { cuTasks, cuWorkspaces, cuMembers } from '../schema.js';
import { inArray, sql } from 'drizzle-orm';

// kept for downstream usage / future joins
void cuMembers;

const OPEN_STATUS_PREDICATE = sql`(${cuTasks.status} IS NULL OR ${cuTasks.status} NOT IN ('closed', 'done', 'cancelled'))`;
void OPEN_STATUS_PREDICATE;

export type WorkloadResult = {
  data_source: 'snapshot';
  as_of: string;
  results: Array<{ group_id: string; group_name: string | null; count: number; total_estimate_ms: number; max_due_date: string | null }>;
};

async function oldestAsOf(workspaceIds: string[]): Promise<Date> {
  if (workspaceIds.length === 0) return new Date(0);
  const rows = await db
    .select({ asOf: cuWorkspaces.lastIncrementalSyncAt })
    .from(cuWorkspaces)
    .where(inArray(cuWorkspaces.workspaceId, workspaceIds));
  return rows.reduce<Date>((acc, r) => {
    const t = r.asOf ?? new Date(0);
    return t.getTime() < acc.getTime() ? t : acc;
  }, new Date());
}

export async function aggregateWorkload(opts: { workspaceIds: string[]; groupBy: 'assignee' | 'list' | 'space' }): Promise<WorkloadResult> {
  const { workspaceIds, groupBy } = opts;
  if (workspaceIds.length === 0) {
    return { data_source: 'snapshot', as_of: new Date(0).toISOString(), results: [] };
  }
  const asOf = await oldestAsOf(workspaceIds);

  if (groupBy === 'assignee') {
    const rows = await db.execute(sql`
      WITH unrolled AS (
        SELECT (a->>'id') AS assignee_id, t.time_estimate, t.due_date, t.task_id, t.workspace_id
        FROM cu_tasks t, jsonb_array_elements(t.assignees) a
        WHERE t.workspace_id IN (${sql.join(workspaceIds.map((w) => sql`${w}`), sql`, `)})
          AND t.deleted_at IS NULL
          AND (t.status IS NULL OR t.status NOT IN ('closed', 'done', 'cancelled'))
      )
      SELECT u.assignee_id AS group_id,
             m.name AS group_name,
             COUNT(*)::int AS count,
             COALESCE(SUM(u.time_estimate), 0)::bigint AS total_estimate_ms,
             MAX(u.due_date)::text AS max_due_date
      FROM unrolled u
      LEFT JOIN cu_members m ON m.member_id = u.assignee_id AND m.workspace_id = u.workspace_id
      GROUP BY u.assignee_id, m.name
      ORDER BY COUNT(*) DESC
    `);
    return {
      data_source: 'snapshot',
      as_of: asOf.toISOString(),
      results: (rows as unknown as Array<{ group_id: string; group_name: string | null; count: number; total_estimate_ms: string | number; max_due_date: string | null }>).map((r) => ({
        group_id: r.group_id,
        group_name: r.group_name,
        count: Number(r.count),
        total_estimate_ms: Number(r.total_estimate_ms),
        max_due_date: r.max_due_date,
      })),
    };
  }

  // group by list or space — list_id and space_id are unique across the user's
  // workspaces (ClickUp enforces global ids), so we can group on them directly.
  const groupCol = groupBy === 'list' ? sql`${cuTasks.listId}` : sql`(SELECT space_id FROM cu_lists WHERE id = ${cuTasks.listId})`;
  const rows = await db.execute(sql`
    SELECT ${groupCol} AS group_id,
           COUNT(*)::int AS count,
           COALESCE(SUM(time_estimate), 0)::bigint AS total_estimate_ms,
           MAX(due_date)::text AS max_due_date
    FROM cu_tasks
    WHERE workspace_id IN (${sql.join(workspaceIds.map((w) => sql`${w}`), sql`, `)})
      AND deleted_at IS NULL
      AND (status IS NULL OR status NOT IN ('closed', 'done', 'cancelled'))
    GROUP BY ${groupCol}
    ORDER BY COUNT(*) DESC
  `);
  return {
    data_source: 'snapshot',
    as_of: asOf.toISOString(),
    results: (rows as unknown as Array<{ group_id: string; count: number; total_estimate_ms: string | number; max_due_date: string | null }>).map((r) => ({
      group_id: r.group_id,
      group_name: null,
      count: Number(r.count),
      total_estimate_ms: Number(r.total_estimate_ms),
      max_due_date: r.max_due_date,
    })),
  };
}

export type ThroughputResult = {
  data_source: 'snapshot';
  as_of: string;
  total_completed: number;
  by_day: Array<{ day: string; count: number }>;
};

export async function aggregateThroughput(opts: { workspaceIds: string[]; since: string; until: string }): Promise<ThroughputResult> {
  const { workspaceIds, since, until } = opts;
  if (workspaceIds.length === 0) {
    return { data_source: 'snapshot', as_of: new Date(0).toISOString(), total_completed: 0, by_day: [] };
  }
  const asOf = await oldestAsOf(workspaceIds);

  const rows = await db.execute(sql`
    SELECT to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM cu_tasks
    WHERE workspace_id IN (${sql.join(workspaceIds.map((w) => sql`${w}`), sql`, `)})
      AND deleted_at IS NULL
      AND completed_at IS NOT NULL
      AND completed_at >= ${since}::timestamp
      AND completed_at <= ${until}::timestamp
    GROUP BY 1 ORDER BY 1
  `);

  const byDay = (rows as unknown as Array<{ day: string; count: number }>).map((r) => ({ day: r.day, count: Number(r.count) }));
  return {
    data_source: 'snapshot',
    as_of: asOf.toISOString(),
    total_completed: byDay.reduce((s, r) => s + r.count, 0),
    by_day: byDay,
  };
}
