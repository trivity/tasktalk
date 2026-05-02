import { db } from '../db/client.js';
import { cuWorkspaces, clickupConnections } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';
import { upsertTask, softDeleteTask } from './upsert.js';
import type { SyncTaskPayload } from './boss.js';
import { broadcastSystemEvent } from './system-events.js';

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
    let lastTask: Record<string, unknown> | null = null;
    let wasDeleted = false;
    try {
      const resp = await callMcpTool<{ task: Record<string, unknown> }>(session, 'clickup_get_task', { task_id: taskId });
      if (resp?.task) {
        await upsertTask(workspaceId, resp.task);
        lastTask = resp.task;
      } else {
        await softDeleteTask(taskId);
        wasDeleted = true;
      }
    } catch (e) {
      const msg = String((e as Error).message ?? '');
      if (/404|not.found/i.test(msg)) {
        await softDeleteTask(taskId);
        wasDeleted = true;
      } else {
        throw e;
      }
    }
    await db.update(cuWorkspaces).set({ lastIncrementalSyncAt: new Date() }).where(eq(cuWorkspaces.workspaceId, workspaceId));

    await broadcastSystemEvent({
      workspaceId,
      taskId,
      changeType: wasDeleted ? 'deleted' : 'updated',
      taskName: lastTask ? String(lastTask.name ?? taskId) : taskId,
    });
  } finally {
    await pool.closeAll();
  }
}
