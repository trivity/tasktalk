import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { auditLog, conversations, clickupConnections, cuWorkspaces } from '../db/schema.js';
import { and, eq, inArray, isNull, desc } from 'drizzle-orm';
import { executeWrite } from '../claude/write-executor.js';
import { runTurn } from '../claude/turn-loop.js';

export const undoRoutes = new Hono()
  .use('*', requireAuth)
  .post('/:conversationId', async (c) => {
    const u = c.get('user');
    const conversationId = c.req.param('conversationId');

    const [conv] = await db.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, u.id))).limit(1);
    if (!conv) return c.json({ error: 'not_found' }, 404);

    const [last] = await db.select().from(auditLog)
      .where(and(eq(auditLog.conversationId, conversationId), eq(auditLog.undone, false), eq(auditLog.status, 'ok')))
      .orderBy(desc(auditLog.createdAt)).limit(1);
    if (!last) return c.json({ error: 'nothing_to_undo' }, 400);

    const conns = await db.select().from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt)));
    if (conns.length === 0) return c.json({ error: 'clickup_not_connected' }, 400);
    const workspaceIds = conns.map((c) => c.workspaceId).filter((id) => !id.startsWith('pending-'));
    if (workspaceIds.length === 0) return c.json({ error: 'no_workspace_synced' }, 400);

    const inverse = inverseAction(last.action, last.before, last.after, last.targetId);
    if (!inverse) return c.json({ error: 'cannot_undo' }, 400);

    const result = await executeWrite({
      userId: u.id,
      conversationId,
      workspaceIds,
      messageId: null,
      toolName: inverse.toolName,
      args: inverse.args,
    });

    if (result.ok && result.auditId) {
      await db.update(auditLog).set({ undone: true, undoTargetId: result.auditId }).where(eq(auditLog.id, last.id));
      await db.update(auditLog).set({ action: 'undo' }).where(eq(auditLog.id, result.auditId));
    }

    const wsRows = await db.select().from(cuWorkspaces).where(inArray(cuWorkspaces.workspaceId, workspaceIds));
    const wsName = wsRows.length === 0
      ? '(unknown)'
      : wsRows.length === 1
        ? (wsRows[0]!.name ?? '(unknown)')
        : `${wsRows[0]!.name ?? 'Workspace'} (+${wsRows.length - 1} more)`;
    return streamSSE(c, async (sse) => {
      await runTurn({
        userId: u.id,
        conversationId,
        userText: result.ok
          ? `[system: undo of '${last.action}' on ${last.targetType} ${last.targetId} succeeded]`
          : `[system: undo failed: ${result.error}]`,
        userName: u.name,
        userEmail: u.email,
        workspaceIds,
        workspaceName: wsName,
        emit: async (e) => { await sse.writeSSE({ data: JSON.stringify(e) }); },
      });
      await sse.writeSSE({ event: 'done', data: '{}' });
    });
  });

function inverseAction(
  action: string,
  before: unknown,
  after: unknown,
  targetId: string,
): { toolName: 'create_task' | 'update_task' | 'add_comment' | 'delete_task'; args: Record<string, unknown> } | null {
  if (action === 'create_task') {
    const taskId = (after as Record<string, unknown> | null)?.id ? String((after as Record<string, unknown>).id) : targetId;
    return { toolName: 'delete_task', args: { task_id: taskId } };
  }
  if (action === 'update_task') {
    const b = before as Record<string, unknown> | null;
    if (!b) return null;
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'status', 'priority', 'dueDate', 'startDate']) {
      if (k in b) patch[mapMirrorKey(k)] = b[k];
    }
    return { toolName: 'update_task', args: { task_id: targetId, patch } };
  }
  if (action === 'add_comment') {
    const commentId = (after as Record<string, unknown> | null)?.id;
    if (!commentId) return null;
    return null;
  }
  if (action === 'delete_task') {
    const b = before as Record<string, unknown> | null;
    if (!b) return null;
    return {
      toolName: 'create_task',
      args: {
        list_id: String((b.list as Record<string, unknown> | undefined)?.id ?? b.listId),
        name: String(b.name),
        description: b.description ?? '',
        priority: b.priority ?? null,
        due_date: b.dueDate ?? null,
      },
    };
  }
  return null;
}

function mapMirrorKey(k: string): string {
  if (k === 'dueDate') return 'due_date';
  if (k === 'startDate') return 'start_date';
  return k;
}
