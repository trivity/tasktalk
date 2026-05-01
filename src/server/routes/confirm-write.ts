import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { pendingWrites, conversations, clickupConnections, cuWorkspaces, messages } from '../db/schema.js';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { executeWrite } from '../claude/write-executor.js';
import { runTurn } from '../claude/turn-loop.js';

const body = z.object({ confirmation_token: z.string().uuid(), confirm: z.boolean() });

export const confirmWriteRoutes = new Hono()
  .use('*', requireAuth)
  .post('/', zValidator('json', body), async (c) => {
    const u = c.get('user');
    const { confirmation_token, confirm } = c.req.valid('json');

    const [pending] = await db.select().from(pendingWrites)
      .where(and(
        eq(pendingWrites.confirmationToken, confirmation_token),
        eq(pendingWrites.userId, u.id),
        isNull(pendingWrites.consumedAt),
        gt(pendingWrites.expiresAt, new Date()),
      ))
      .limit(1);
    if (!pending) return c.json({ error: 'token_invalid_or_expired' }, 404);

    // mark consumed FIRST so a double-click can't re-execute
    await db.update(pendingWrites).set({ consumedAt: new Date() }).where(eq(pendingWrites.confirmationToken, confirmation_token));

    if (!confirm) {
      // user denied — append a synthetic tool_result-as-tool-message
      await db.insert(messages).values({
        conversationId: pending.conversationId,
        role: 'tool',
        content: { tool_use_id: pending.toolUseId, status: 'denied' },
      });
      return c.json({ ok: true, status: 'denied' });
    }

    const [conn] = await db.select().from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt))).limit(1);
    if (!conn) return c.json({ error: 'clickup_not_connected' }, 400);

    const result = await executeWrite({
      userId: u.id,
      conversationId: pending.conversationId,
      workspaceId: conn.workspaceId,
      messageId: null,
      toolName: pending.toolName as 'create_task' | 'update_task' | 'add_comment' | 'delete_task',
      args: pending.args,
    });

    // persist tool result message so future turns include it as part of history
    await db.insert(messages).values({
      conversationId: pending.conversationId,
      role: 'tool',
      content: {
        tool_use_id: pending.toolUseId,
        ok: result.ok,
        result: result.ok ? result.result : null,
        error: result.error ?? null,
        audit_id: result.auditId,
      },
    });

    // continue the turn: stream Claude's reaction to the result
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, pending.conversationId)).limit(1);
    const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, conn.workspaceId)).limit(1);
    void conv;

    return streamSSE(c, async (sse) => {
      await runTurn({
        userId: u.id,
        conversationId: pending.conversationId,
        userText: result.ok
          ? `[system: write '${pending.toolName}' confirmed and succeeded]`
          : `[system: write '${pending.toolName}' confirmed but failed: ${result.error}]`,
        userName: u.name,
        userEmail: u.email,
        workspaceId: conn.workspaceId,
        workspaceName: ws?.name ?? '(unknown)',
        emit: async (event) => { await sse.writeSSE({ data: JSON.stringify(event) }); },
      });
      await sse.writeSSE({ event: 'done', data: '{}' });
    });
  });
