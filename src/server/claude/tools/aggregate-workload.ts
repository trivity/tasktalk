import { aggregateWorkload } from '../../db/queries/aggregates.js';
import { db } from '../../db/client.js';
import { cuTasks } from '../../db/schema.js';
import { inArray, sql } from 'drizzle-orm';

export async function executeAggregateWorkload(workspaceIds: string[], groupBy: 'assignee' | 'list' | 'space') {
  if (workspaceIds.length === 0) {
    return { data_source: 'snapshot' as const, as_of: new Date(0).toISOString(), results: [], first_run: true, truncated: false };
  }
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cuTasks)
    .where(inArray(cuTasks.workspaceId, workspaceIds));
  const count = countRows[0]?.count ?? 0;
  if (count === 0) {
    return { data_source: 'snapshot' as const, as_of: new Date(0).toISOString(), results: [], first_run: true, truncated: false };
  }
  const r = await aggregateWorkload({ workspaceIds, groupBy });
  return { ...r, truncated: false };
}
