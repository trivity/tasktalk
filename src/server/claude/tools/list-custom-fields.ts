import { db } from '../../db/client.js';
import { cuCustomFields, cuWorkspaces } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';

export async function executeListCustomFields(workspaceId: string, scopeId?: string) {
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  const rows = scopeId
    ? await db.select().from(cuCustomFields).where(and(eq(cuCustomFields.workspaceId, workspaceId), eq(cuCustomFields.scopeId, scopeId)))
    : await db.select().from(cuCustomFields).where(eq(cuCustomFields.workspaceId, workspaceId));
  return {
    data_source: 'snapshot' as const,
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    results: rows.map((r) => ({ id: r.customFieldId, name: r.name, type: r.type, scope_id: r.scopeId, scope_type: r.scopeType, config: r.config })),
    truncated: false,
  };
}
