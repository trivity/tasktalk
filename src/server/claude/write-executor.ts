import { db } from '../db/client.js';
import { auditLog, cuTasks } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { callMcpTool, openMcpSession } from '../mcp/client.js';
import { upsertTask, softDeleteTask } from '../sync/upsert.js';

export type WriteResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  auditId?: string;
};

export async function executeWrite(opts: {
  userId: string;
  conversationId: string;
  workspaceId: string;
  messageId: string | null; // assistant message that proposed the write (set when known)
  toolName: 'create_task' | 'update_task' | 'add_comment' | 'delete_task';
  args: Record<string, unknown>;
}): Promise<WriteResult> {
  // 1. snapshot 'before' from mirror
  const before = await readBefore(opts);

  // 2. insert audit_log with status=pending
  const [audit] = await db.insert(auditLog).values({
    userId: opts.userId,
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    action: opts.toolName,
    targetType: opts.toolName === 'add_comment' ? 'comment' : 'task',
    targetId: targetIdFor(opts.toolName, opts.args),
    before,
    status: 'pending',
  }).returning();

  // 3. live MCP call
  const session = await openMcpSession(opts.userId);
  try {
    let mcpResult: Record<string, unknown> | null = null;
    if (opts.toolName === 'create_task') {
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'clickup_create_task', opts.args);
    } else if (opts.toolName === 'update_task') {
      const { task_id, patch } = opts.args as { task_id: string; patch: Record<string, unknown> };
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'clickup_update_task', { task_id, ...patch });
    } else if (opts.toolName === 'add_comment') {
      const { task_id, text } = opts.args as { task_id: string; text: string };
      // ClickUp's clickup_create_task_comment expects `comment_text`, not `text`.
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'clickup_create_task_comment', { task_id, comment_text: text });
    } else if (opts.toolName === 'delete_task') {
      const { task_id } = opts.args as { task_id: string };
      await callMcpTool(session, 'clickup_delete_task', { task_id });
      mcpResult = null;
    }

    // 4. mirror upsert / soft delete
    if (opts.toolName === 'delete_task') {
      const { task_id } = opts.args as { task_id: string };
      await softDeleteTask(task_id);
    } else if (opts.toolName === 'create_task' || opts.toolName === 'update_task') {
      // re-fetch via get_task for canonical 'after'
      const taskId = opts.toolName === 'create_task'
        ? (mcpResult?.id ? String(mcpResult.id) : '')
        : String((opts.args as { task_id: string }).task_id);
      if (taskId) {
        try {
          const fetched = await callMcpTool<{ task: Record<string, unknown> }>(session, 'clickup_get_task', { task_id: taskId });
          if (fetched?.task) await upsertTask(opts.workspaceId, fetched.task);
          mcpResult = fetched?.task ?? mcpResult;
        } catch { /* best-effort */ }
      }
    }

    // 5. flip audit_log to ok
    await db.update(auditLog).set({ status: 'ok', after: mcpResult ?? null }).where(eq(auditLog.id, audit!.id));

    return { ok: true, result: mcpResult, auditId: audit!.id };
  } catch (err) {
    const message = String((err as Error).message ?? err);
    await db.update(auditLog).set({ status: 'failed', errorMessage: message }).where(eq(auditLog.id, audit!.id));
    return { ok: false, error: message, auditId: audit!.id };
  } finally {
    await session.close();
  }
}

async function readBefore(opts: { workspaceId: string; toolName: string; args: Record<string, unknown> }): Promise<unknown> {
  if (opts.toolName === 'create_task' || opts.toolName === 'add_comment') return null;
  const taskId = String((opts.args as { task_id?: string }).task_id ?? '');
  if (!taskId) return null;
  const [t] = await db.select().from(cuTasks).where(and(eq(cuTasks.taskId, taskId), eq(cuTasks.workspaceId, opts.workspaceId))).limit(1);
  return t ?? null;
}

function targetIdFor(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'create_task') return '(pending)'; // updated to actual id after success in caller
  return String((args as { task_id?: string }).task_id ?? '');
}
