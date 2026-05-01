import { aggregateWorkload } from '../../db/queries/aggregates.js';
import { db } from '../../db/client.js';
import { cuTasks } from '../../db/schema.js';
import { sql } from 'drizzle-orm';

export async function executeAggregateWorkload(workspaceId: string, groupBy: 'assignee' | 'list' | 'space') {
  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(cuTasks).where(sql`${cuTasks.workspaceId} = ${workspaceId}`);
  const count = countRows[0]?.count ?? 0;
  if (count === 0) {
    return { data_source: 'snapshot' as const, as_of: new Date(0).toISOString(), results: [], first_run: true, truncated: false };
  }
  const r = await aggregateWorkload({ workspaceId, groupBy });
  return { ...r, truncated: false };
}
