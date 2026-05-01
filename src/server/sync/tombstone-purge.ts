import { db } from '../db/client.js';
import {
  clickupConnections,
  cuWorkspaces,
  cuSpaces,
  cuFolders,
  cuLists,
  cuTasks,
  cuMembers,
  cuCustomFields,
} from '../db/schema.js';
import { and, eq, lt, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { removeWorkspaceWebhook } from './webhooks.js';

export async function runTombstonePurge(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const expired = await db
    .select()
    .from(clickupConnections)
    .where(
      and(
        isNotNull(clickupConnections.tombstonedAt),
        lt(clickupConnections.tombstonedAt, cutoff),
      ),
    );

  for (const c of expired) {
    try {
      await removeWorkspaceWebhook(c.userId, c.workspaceId);
    } catch {
      /* tokens may already be invalid */
    }
    // hard-delete connection
    await db.delete(clickupConnections).where(eq(clickupConnections.id, c.id));

    // if no other active connection points to this workspace, purge mirror
    const [otherActive] = await db
      .select()
      .from(clickupConnections)
      .where(
        and(
          eq(clickupConnections.workspaceId, c.workspaceId),
          sql`${clickupConnections.tombstonedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (!otherActive) {
      // cu_task_custom_field_values cascades from cu_tasks via ON DELETE CASCADE on the FK
      await db.delete(cuTasks).where(eq(cuTasks.workspaceId, c.workspaceId));
      await db.delete(cuCustomFields).where(eq(cuCustomFields.workspaceId, c.workspaceId));
      await db.delete(cuLists).where(eq(cuLists.workspaceId, c.workspaceId));
      await db.delete(cuFolders).where(eq(cuFolders.workspaceId, c.workspaceId));
      await db.delete(cuSpaces).where(eq(cuSpaces.workspaceId, c.workspaceId));
      await db.delete(cuMembers).where(eq(cuMembers.workspaceId, c.workspaceId));
      await db.delete(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, c.workspaceId));
    }
  }
}
