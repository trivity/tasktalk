import { db } from '../db/client.js';
import { cuTasks, cuLists } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';

export type PreviewField = { key: string; before: unknown; after: unknown };
export type PreviewTarget = { type: 'task' | 'comment' | 'list'; id: string; name: string };

export type Preview =
  | { kind: 'update_task'; target: PreviewTarget; fields: PreviewField[]; destructive: false }
  | { kind: 'create_task'; target: PreviewTarget; fields: PreviewField[]; destructive: false }
  | { kind: 'delete_task'; target: PreviewTarget; fields: PreviewField[]; destructive: true }
  | { kind: 'add_comment'; target: PreviewTarget; fields: PreviewField[]; destructive: false };

export async function buildPreview(opts: {
  workspaceId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<Preview> {
  const { workspaceId, toolName, args } = opts;

  if (toolName === 'update_task') {
    const taskId = String(args.task_id);
    const patch = (args.patch as Record<string, unknown>) ?? {};
    const [task] = await db.select().from(cuTasks).where(and(eq(cuTasks.taskId, taskId), eq(cuTasks.workspaceId, workspaceId))).limit(1);
    if (!task) throw new Error(`task not found in mirror: ${taskId}`);
    const fields: PreviewField[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const before = (task as Record<string, unknown>)[mapPatchKey(k)];
      fields.push({ key: k, before, after: v });
    }
    return { kind: 'update_task', target: { type: 'task', id: task.taskId, name: task.name }, fields, destructive: false };
  }

  if (toolName === 'create_task') {
    const listId = String(args.list_id);
    const [list] = await db.select().from(cuLists).where(and(eq(cuLists.id, listId), eq(cuLists.workspaceId, workspaceId))).limit(1);
    const fields: PreviewField[] = Object.entries(args)
      .filter(([k]) => k !== 'list_id')
      .map(([k, v]) => ({ key: k, before: null, after: v }));
    return { kind: 'create_task', target: { type: 'list', id: listId, name: list?.name ?? '(unknown list)' }, fields, destructive: false };
  }

  if (toolName === 'delete_task') {
    const taskId = String(args.task_id);
    const [task] = await db.select().from(cuTasks).where(and(eq(cuTasks.taskId, taskId), eq(cuTasks.workspaceId, workspaceId))).limit(1);
    if (!task) throw new Error(`task not found in mirror: ${taskId}`);
    return {
      kind: 'delete_task',
      target: { type: 'task', id: task.taskId, name: task.name },
      fields: [
        { key: 'name', before: task.name, after: null },
        { key: 'status', before: task.status, after: null },
      ],
      destructive: true,
    };
  }

  if (toolName === 'add_comment') {
    const taskId = String(args.task_id);
    const [task] = await db.select().from(cuTasks).where(and(eq(cuTasks.taskId, taskId), eq(cuTasks.workspaceId, workspaceId))).limit(1);
    return {
      kind: 'add_comment',
      target: { type: 'task', id: taskId, name: task?.name ?? `(task ${taskId})` },
      fields: [{ key: 'text', before: null, after: args.text }],
      destructive: false,
    };
  }

  throw new Error(`buildPreview: unknown tool ${toolName}`);
}

function mapPatchKey(k: string): string {
  // patch keys map to mirror columns; mirror uses camelCase via Drizzle, so adjust here
  switch (k) {
    case 'due_date': return 'dueDate';
    case 'start_date': return 'startDate';
    case 'parent_task_id': return 'parentTaskId';
    case 'list_id': return 'listId';
    default: return k;
  }
}
