import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { runTurn } from '../claude/turn-loop.js';
import { db } from '../db/client.js';
import { conversations, clickupConnections, cuWorkspaces } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';

const turnBody = z.object({ text: z.string().min(1).max(8000) });

export const chatRoutes = new Hono()
  .use('*', requireAuth)
  .post('/:conversationId/turn', zValidator('json', turnBody), async (c) => {
    const u = c.get('user');
    const conversationId = c.req.param('conversationId');
    const { text } = c.req.valid('json');

    const [conv] = await db.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, u.id))).limit(1);
    if (!conv) return c.json({ error: 'not_found' }, 404);

    const [conn] = await db.select().from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt))).limit(1);
    if (!conn) return c.json({ error: 'clickup_not_connected' }, 400);

    const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, conn.workspaceId)).limit(1);
    const workspaceName = ws?.name ?? '(unknown)';

    return streamSSE(c, async (sse) => {
      await runTurn({
        userId: u.id,
        conversationId,
        userText: text,
        userName: u.name,
        userEmail: u.email,
        workspaceId: conn.workspaceId,
        workspaceName,
        emit: async (event) => {
          await sse.writeSSE({ data: JSON.stringify(event) });
        },
      });
      await sse.writeSSE({ event: 'done', data: '{}' });
    });
  });
