import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware.js';
import { estimateWorkspaceSize } from '../sync/workspace-estimate.js';
import { db } from '../db/client.js';

export const onboardingRoutes = new Hono()
  .use('*', requireAuth)
  .get('/estimate', async (c) => {
    const u = c.get('user');
    try {
      const r = await estimateWorkspaceSize(u.id);
      return c.json(r);
    } catch (e) {
      return c.json({ error: String((e as Error).message ?? e) }, 500);
    }
  })
  .get('/sync-progress', async (c) => {
    const u = c.get('user');
    // join clickup_connections → cu_workspaces (for the user's connected workspace)
    const rows = await db.execute(sql`
      SELECT cw.workspace_id, cw.name, cw.last_full_sync_at, cw.sync_state
      FROM cu_workspaces cw
      JOIN clickup_connections cc ON cc.workspace_id = cw.workspace_id
      WHERE cc.user_id = ${u.id}
        AND cc.tombstoned_at IS NULL
      LIMIT 1
    `);
    const r = (rows as unknown as Array<{
      workspace_id: string;
      name: string;
      last_full_sync_at: Date | null;
      sync_state: { phase?: string; listsDone?: number; listsTotal?: number };
    }>)[0];
    if (!r) return c.json({ status: 'pending' });
    return c.json({
      status: r.last_full_sync_at ? 'done' : 'running',
      syncState: r.sync_state,
      workspace: { id: r.workspace_id, name: r.name },
    });
  });
