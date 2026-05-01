import { db } from '../../db/client.js';
import { cuSpaces, cuFolders, cuLists, cuWorkspaces } from '../../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';

export async function executeListOrgStructure(workspaceId: string) {
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  const spaces = await db.select().from(cuSpaces).where(and(eq(cuSpaces.workspaceId, workspaceId), isNull(cuSpaces.deletedAt)));
  const folders = await db.select().from(cuFolders).where(and(eq(cuFolders.workspaceId, workspaceId), isNull(cuFolders.deletedAt)));
  const lists = await db.select().from(cuLists).where(and(eq(cuLists.workspaceId, workspaceId), isNull(cuLists.deletedAt)));

  const tree = spaces.map((s) => ({
    id: s.id, name: s.name,
    folders: folders.filter((f) => f.spaceId === s.id).map((f) => ({
      id: f.id, name: f.name,
      lists: lists.filter((l) => l.folderId === f.id).map((l) => ({ id: l.id, name: l.name })),
    })),
    folderless_lists: lists.filter((l) => l.spaceId === s.id && !l.folderId).map((l) => ({ id: l.id, name: l.name })),
  }));

  return {
    data_source: 'snapshot' as const,
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    results: tree,
    truncated: false,
  };
}
