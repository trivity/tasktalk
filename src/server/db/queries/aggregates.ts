import { db } from '../client.js';
import { cuTasks, cuWorkspaces, cuMembers } from '../schema.js';
import { sql } from 'drizzle-orm';

// kept for downstream usage / future joins
void cuMembers;

const OPEN_STATUS_PREDICATE = sql`(${cuTasks.status} IS NULL OR ${cuTasks.status} NOT IN ('closed', 'done', 'cancelled'))`;
void OPEN_STATUS_PREDICATE;

export type WorkloadResult = {
  data_source: 'snapshot';
  as_of: string;
  results: Array<{ group_id: string; group_name: string | null; count: number; total_estimate_ms: number; max_due_date: string | null }>;
};

export async function aggregateWorkload(opts: { workspaceId: string; groupBy: 'assignee' | 'list' | 'space' }): Promise<WorkloadResult> {
  const ws = opts.workspaceId;
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(sql`${cuWorkspaces.workspaceId} = ${ws}`).limit(1);

  if (opts.groupBy === 'assignee') {
    const rows = await db.execute(sql`
      WITH unrolled AS (
        SELECT (a->>'id') AS assignee_id, t.time_estimate, t.due_date, t.task_id
        FROM cu_tasks t, jsonb_array_elements(t.assignees) a
        WHERE t.workspace_id = ${ws}
          AND t.deleted_at IS NULL
          AND (t.status IS NULL OR t.status NOT IN ('closed', 'done', 'cancelled'))
      )
      SELECT u.assignee_id AS group_id,
             m.name AS group_name,
             COUNT(*)::int AS count,
             COALESCE(SUM(u.time_estimate), 0)::bigint AS total_estimate_ms,
             MAX(u.due_date)::text AS max_due_date
      FROM unrolled u
      LEFT JOIN cu_members m ON m.member_id = u.assignee_id AND m.workspace_id = ${ws}
      GROUP BY u.assignee_id, m.name
      ORDER BY COUNT(*) DESC
    `);
    return {
      data_source: 'snapshot',
      as_of: (w?.asOf ?? new Date(0)).toISOString(),
      results: (rows as unknown as Array<{ group_id: string; group_name: string | null; count: number; total_estimate_ms: string | number; max_due_date: string | null }>).map((r) => ({
        group_id: r.group_id,
        group_name: r.group_name,
        count: Number(r.count),
        total_estimate_ms: Number(r.total_estimate_ms),
        max_due_date: r.max_due_date,
      })),
    };
  }

  // group by list or space
  const groupCol = opts.groupBy === 'list' ? sql`${cuTasks.listId}` : sql`(SELECT space_id FROM cu_lists WHERE id = ${cuTasks.listId})`;
  const rows = await db.execute(sql`
    SELECT ${groupCol} AS group_id,
           COUNT(*)::int AS count,
           COALESCE(SUM(time_estimate), 0)::bigint AS total_estimate_ms,
           MAX(due_date)::text AS max_due_date
    FROM cu_tasks
    WHERE workspace_id = ${ws}
      AND deleted_at IS NULL
      AND (status IS NULL OR status NOT IN ('closed', 'done', 'cancelled'))
    GROUP BY ${groupCol}
    ORDER BY COUNT(*) DESC
  `);
  return {
    data_source: 'snapshot',
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
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

export async function aggregateThroughput(opts: { workspaceId: string; since: string; until: string }): Promise<ThroughputResult> {
  const ws = opts.workspaceId;
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(sql`${cuWorkspaces.workspaceId} = ${ws}`).limit(1);

  const rows = await db.execute(sql`
    SELECT to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM cu_tasks
    WHERE workspace_id = ${ws}
      AND deleted_at IS NULL
      AND completed_at IS NOT NULL
      AND completed_at >= ${opts.since}::timestamp
      AND completed_at <= ${opts.until}::timestamp
    GROUP BY 1 ORDER BY 1
  `);

  const byDay = (rows as unknown as Array<{ day: string; count: number }>).map((r) => ({ day: r.day, count: Number(r.count) }));
  return {
    data_source: 'snapshot',
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    total_completed: byDay.reduce((s, r) => s + r.count, 0),
    by_day: byDay,
  };
}
