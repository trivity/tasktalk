import { aggregateThroughput } from '../../db/queries/aggregates.js';
import { db } from '../../db/client.js';
import { cuTasks } from '../../db/schema.js';
import { sql } from 'drizzle-orm';

export async function executeAggregateThroughput(workspaceId: string, since: string, until: string) {
  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(cuTasks).where(sql`${cuTasks.workspaceId} = ${workspaceId}`);
  const count = countRows[0]?.count ?? 0;
  if (count === 0) {
    return { data_source: 'snapshot' as const, as_of: new Date(0).toISOString(), total_completed: 0, by_day: [], first_run: true };
  }
  return await aggregateThroughput({ workspaceId, since, until });
}
