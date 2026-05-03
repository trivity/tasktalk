import { db } from '../../db/client.js';
import { cuSpaces, cuFolders, cuLists, cuWorkspaces } from '../../db/schema.js';
import { and, inArray, isNull } from 'drizzle-orm';

export async function executeListOrgStructure(workspaceIds: string[]) {
  if (workspaceIds.length === 0) {
    return { data_source: 'snapshot' as const, as_of: new Date(0).toISOString(), results: [], truncated: false };
  }
  const wsRows = await db
    .select()
    .from(cuWorkspaces)
    .where(inArray(cuWorkspaces.workspaceId, workspaceIds));
  const oldest = wsRows.reduce<Date>((acc, r) => {
    const t = r.lastIncrementalSyncAt ?? new Date(0);
    return t.getTime() < acc.getTime() ? t : acc;
  }, new Date());

  const spaces = await db.select().from(cuSpaces).where(and(inArray(cuSpaces.workspaceId, workspaceIds), isNull(cuSpaces.deletedAt)));
  const folders = await db.select().from(cuFolders).where(and(inArray(cuFolders.workspaceId, workspaceIds), isNull(cuFolders.deletedAt)));
  const lists = await db.select().from(cuLists).where(and(inArray(cuLists.workspaceId, workspaceIds), isNull(cuLists.deletedAt)));

  // Group by workspace so the LLM can disambiguate when the user has multiple.
  const results = wsRows.map((ws) => {
    const wsId = ws.workspaceId;
    const wsSpaces = spaces.filter((s) => s.workspaceId === wsId);
    return {
      workspace_id: wsId,
      workspace_name: ws.name,
      spaces: wsSpaces.map((s) => ({
        id: s.id,
        name: s.name,
        folders: folders.filter((f) => f.spaceId === s.id).map((f) => ({
          id: f.id,
          name: f.name,
          lists: lists.filter((l) => l.folderId === f.id).map((l) => ({ id: l.id, name: l.name })),
        })),
        folderless_lists: lists.filter((l) => l.spaceId === s.id && !l.folderId).map((l) => ({ id: l.id, name: l.name })),
      })),
    };
  });

  return {
    data_source: 'snapshot' as const,
    as_of: (wsRows.length > 0 ? oldest : new Date(0)).toISOString(),
    results,
    truncated: false,
  };
}
