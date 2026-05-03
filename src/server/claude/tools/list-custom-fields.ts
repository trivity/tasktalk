import { db } from '../../db/client.js';
import { cuCustomFields, cuWorkspaces } from '../../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';

export async function executeListCustomFields(workspaceIds: string[], scopeId?: string) {
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

  const rows = scopeId
    ? await db.select().from(cuCustomFields).where(and(inArray(cuCustomFields.workspaceId, workspaceIds), eq(cuCustomFields.scopeId, scopeId)))
    : await db.select().from(cuCustomFields).where(inArray(cuCustomFields.workspaceId, workspaceIds));
  return {
    data_source: 'snapshot' as const,
    as_of: (wsRows.length > 0 ? oldest : new Date(0)).toISOString(),
    results: rows.map((r) => ({
      id: r.customFieldId,
      name: r.name,
      type: r.type,
      scope_id: r.scopeId,
      scope_type: r.scopeType,
      workspace_id: r.workspaceId,
      config: r.config,
    })),
    truncated: false,
  };
}
