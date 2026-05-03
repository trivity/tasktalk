import { db } from '../db/client.js';
import { auditLog, cuTasks, cuLists } from '../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { callMcpTool, openMcpSession } from '../mcp/client.js';
import { upsertTask, softDeleteTask } from '../sync/upsert.js';

export type WriteResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  auditId?: string;
};

/**
 * Execute a write tool. The target's workspace is resolved from the mirror:
 *   - update_task / add_comment / delete_task → task's workspace_id from cu_tasks
 *   - create_task → list's workspace_id from cu_lists
 * The resolved workspace MUST be one of the user's active workspaces, else the
 * write is rejected (preventing cross-workspace writes the user can't see).
 */
export async function executeWrite(opts: {
  userId: string;
  conversationId: string;
  workspaceIds: string[];
  messageId: string | null;
  toolName: 'create_task' | 'update_task' | 'add_comment' | 'delete_task';
  args: Record<string, unknown>;
}): Promise<WriteResult> {
  // 0. Resolve which workspace the target lives in.
  let resolvedWorkspaceId: string | null = null;
  try {
    resolvedWorkspaceId = await resolveTargetWorkspace(opts);
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
  if (!resolvedWorkspaceId) {
    return { ok: false, error: `target not found in any of the user's workspaces` };
  }

  // 1. snapshot 'before' from mirror
  const before = await readBefore({ workspaceId: resolvedWorkspaceId, toolName: opts.toolName, args: opts.args });

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
  // Force the session to use the resolved workspace id (the open helper picks
  // the first connection, which may be a different workspace).
  (session as unknown as { workspaceId: string }).workspaceId = resolvedWorkspaceId;
  try {
    let mcpResult: Record<string, unknown> | null = null;
    if (opts.toolName === 'create_task') {
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'clickup_create_task', { workspace_id: resolvedWorkspaceId, ...opts.args });
    } else if (opts.toolName === 'update_task') {
      const { task_id, patch } = opts.args as { task_id: string; patch: Record<string, unknown> };
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'clickup_update_task', { workspace_id: resolvedWorkspaceId, task_id, ...patch });
    } else if (opts.toolName === 'add_comment') {
      const { task_id, text } = opts.args as { task_id: string; text: string };
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'clickup_create_task_comment', { workspace_id: resolvedWorkspaceId, task_id, comment_text: text });
    } else if (opts.toolName === 'delete_task') {
      const { task_id } = opts.args as { task_id: string };
      await callMcpTool(session, 'clickup_delete_task', { workspace_id: resolvedWorkspaceId, task_id });
      mcpResult = null;
    }

    // 4. mirror upsert / soft delete
    if (opts.toolName === 'delete_task') {
      const { task_id } = opts.args as { task_id: string };
      await softDeleteTask(task_id);
    } else if (opts.toolName === 'create_task' || opts.toolName === 'update_task') {
      const taskId = opts.toolName === 'create_task'
        ? (mcpResult?.id ? String(mcpResult.id) : '')
        : String((opts.args as { task_id: string }).task_id);
      if (taskId) {
        try {
          const fetched = await callMcpTool<{ task: Record<string, unknown> }>(session, 'clickup_get_task', { workspace_id: resolvedWorkspaceId, task_id: taskId });
          if (fetched?.task) await upsertTask(resolvedWorkspaceId, fetched.task);
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

async function resolveTargetWorkspace(opts: {
  workspaceIds: string[];
  toolName: 'create_task' | 'update_task' | 'add_comment' | 'delete_task';
  args: Record<string, unknown>;
}): Promise<string | null> {
  if (opts.workspaceIds.length === 0) return null;

  if (opts.toolName === 'create_task') {
    const listId = String((opts.args as { list_id?: string }).list_id ?? '');
    if (!listId) return null;
    const [row] = await db
      .select({ workspaceId: cuLists.workspaceId })
      .from(cuLists)
      .where(and(eq(cuLists.id, listId), inArray(cuLists.workspaceId, opts.workspaceIds)))
      .limit(1);
    return row ? row.workspaceId : null;
  }

  // update_task / add_comment / delete_task — look up via cu_tasks.
  const taskId = String((opts.args as { task_id?: string }).task_id ?? '');
  if (!taskId) return null;
  const [row] = await db
    .select({ workspaceId: cuTasks.workspaceId })
    .from(cuTasks)
    .where(and(eq(cuTasks.taskId, taskId), inArray(cuTasks.workspaceId, opts.workspaceIds)))
    .limit(1);
  return row ? row.workspaceId : null;
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
