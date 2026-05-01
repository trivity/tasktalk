import { db } from '../../db/client.js';
import { cuWorkspaces } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export async function executeListWorkspaces(workspaceId: string) {
  const [w] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  return {
    data_source: 'snapshot' as const,
    as_of: (w?.lastIncrementalSyncAt ?? new Date(0)).toISOString(),
    results: w ? [{ workspace_id: w.workspaceId, name: w.name }] : [],
    truncated: false,
  };
}
