import { db } from '../../db/client.js';
import { cuMembers, cuWorkspaces } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export async function executeGetTeamMembers(workspaceId: string) {
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  const rows = await db.select().from(cuMembers).where(eq(cuMembers.workspaceId, workspaceId));
  return {
    data_source: 'snapshot' as const,
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    results: rows.map((m) => ({ member_id: m.memberId, name: m.name, email: m.email, role: m.role })),
    truncated: false,
  };
}
