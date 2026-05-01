import { db } from '../db/client.js';
import { cuWorkspaces, clickupConnections } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';
import { upsertTask, softDeleteTask } from './upsert.js';
import type { SyncTaskPayload } from './boss.js';

export async function runSyncTask({ workspaceId, taskId }: SyncTaskPayload): Promise<void> {
  // pick any active connection for this workspace; webhooks are workspace-level so any user works
  const [conn] = await db
    .select()
    .from(clickupConnections)
    .where(and(eq(clickupConnections.workspaceId, workspaceId), isNull(clickupConnections.tombstonedAt)))
    .limit(1);
  if (!conn) return; // workspace has no active connection — drop event silently

  const pool = new TurnMcpPool(conn.userId);
  const session = await pool.get();
  try {
    try {
      const resp = await callMcpTool<{ task: Record<string, unknown> }>(session, 'get_task', { task_id: taskId });
      if (resp?.task) {
        await upsertTask(workspaceId, resp.task);
      } else {
        await softDeleteTask(taskId);
      }
    } catch (e) {
      const msg = String((e as Error).message ?? '');
      if (/404|not.found/i.test(msg)) {
        await softDeleteTask(taskId);
      } else {
        throw e;
      }
    }
    await db.update(cuWorkspaces).set({ lastIncrementalSyncAt: new Date() }).where(eq(cuWorkspaces.workspaceId, workspaceId));
  } finally {
    await pool.closeAll();
  }
}
