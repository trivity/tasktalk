import { db } from '../../db/client.js';
import { cuMembers, cuWorkspaces } from '../../db/schema.js';
import { inArray } from 'drizzle-orm';

export async function executeGetTeamMembers(workspaceIds: string[]) {
  if (workspaceIds.length === 0) {
    return { data_source: 'snapshot' as const, as_of: new Date(0).toISOString(), results: [], truncated: false };
  }
  const wsRows = await db
    .select({ asOf: cuWorkspaces.lastIncrementalSyncAt })
    .from(cuWorkspaces)
    .where(inArray(cuWorkspaces.workspaceId, workspaceIds));
  const oldest = wsRows.reduce<Date>((acc, r) => {
    const t = r.asOf ?? new Date(0);
    return t.getTime() < acc.getTime() ? t : acc;
  }, new Date());

  const rows = await db.select().from(cuMembers).where(inArray(cuMembers.workspaceId, workspaceIds));
  return {
    data_source: 'snapshot' as const,
    as_of: (wsRows.length > 0 ? oldest : new Date(0)).toISOString(),
    results: rows.map((m) => ({
      member_id: m.memberId,
      name: m.name,
      email: m.email,
      role: m.role,
      workspace_id: m.workspaceId,
    })),
    truncated: false,
  };
}
