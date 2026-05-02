import { db } from '../db/client.js';
import { cuWorkspaces, cuLists, clickupConnections } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';
import { upsertTask } from './upsert.js';
import type { DriftPayload } from './boss.js';
import { pacerForRateLimit } from './pacing.js';

const PACE_CALLS_PER_24H = Number(process.env.SYNC_RATE_LIMIT ?? 300);

export async function runDrift({ workspaceId }: DriftPayload): Promise<void> {
  // sentinel — cron passes 'ALL' to mean "every active workspace"
  if (workspaceId === 'ALL') {
    const ws = await db.selectDistinct({ workspaceId: clickupConnections.workspaceId }).from(clickupConnections).where(isNull(clickupConnections.tombstonedAt));
    for (const row of ws) await driftSingle(row.workspaceId);
    return;
  }
  await driftSingle(workspaceId);
}

async function driftSingle(workspaceId: string): Promise<void> {
  const [conn] = await db.select().from(clickupConnections)
    .where(and(eq(clickupConnections.workspaceId, workspaceId), isNull(clickupConnections.tombstonedAt))).limit(1);
  if (!conn) return;

  const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  if (!ws?.lastIncrementalSyncAt) return; // never fully synced

  const since = ws.lastIncrementalSyncAt;
  const pool = new TurnMcpPool(conn.userId);
  const session = await pool.get();
  const pacer = pacerForRateLimit(PACE_CALLS_PER_24H);
  let drifted = 0;

  try {
    const lists = await db.select().from(cuLists).where(and(eq(cuLists.workspaceId, workspaceId), isNull(cuLists.deletedAt)));
    for (const l of lists) {
      let page = 0;
      const MAX_PAGES = 200;
      while (page < MAX_PAGES) {
        await pacer.acquire();
        let resp: { tasks?: Array<Record<string, unknown>>; last_page?: boolean };
        try {
          resp = await callMcpTool<{ tasks: Array<Record<string, unknown>>; last_page?: boolean }>(
            session,
            'clickup_filter_tasks',
            {
              workspace_id: workspaceId,
              list_id: l.id,
              page,
              date_updated_gt: since.getTime(),
              include_subtasks: true,
            },
          );
        } catch (err) {
          console.warn(`[drift] clickup_filter_tasks list=${l.id} page=${page}: ${(err as Error).message}`);
          break;
        }
        for (const t of resp.tasks ?? []) {
          await upsertTask(workspaceId, t);
          drifted++;
        }
        if (!resp.tasks?.length || resp.last_page) break;
        page++;
      }
    }
    await db.update(cuWorkspaces).set({ lastDriftCount: drifted, lastIncrementalSyncAt: new Date() }).where(eq(cuWorkspaces.workspaceId, workspaceId));
  } finally {
    await pool.closeAll();
  }
}
