import { db } from '../../db/client.js';
import { cuWorkspaces } from '../../db/schema.js';
import { inArray } from 'drizzle-orm';

export async function executeListWorkspaces(workspaceIds: string[]) {
  if (workspaceIds.length === 0) {
    return {
      data_source: 'snapshot' as const,
      as_of: new Date(0).toISOString(),
      results: [],
      truncated: false,
    };
  }
  const rows = await db.select().from(cuWorkspaces).where(inArray(cuWorkspaces.workspaceId, workspaceIds));
  // Pick the OLDEST as_of so the LLM can reason about staleness conservatively.
  const oldest = rows.reduce<Date>((acc, r) => {
    const t = r.lastIncrementalSyncAt ?? new Date(0);
    return t.getTime() < acc.getTime() ? t : acc;
  }, new Date());
  return {
    data_source: 'snapshot' as const,
    as_of: (rows.length > 0 ? oldest : new Date(0)).toISOString(),
    results: rows.map((w) => ({ workspace_id: w.workspaceId, name: w.name })),
    truncated: false,
  };
}
