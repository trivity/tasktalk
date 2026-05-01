import { db } from '../db/client.js';
import {
  cuSpaces, cuFolders, cuLists, cuTasks, cuMembers, cuCustomFields, cuTaskCustomFieldValues, cuWorkspaces,
} from '../db/schema.js';
import { sql } from 'drizzle-orm';

type Json = Record<string, unknown>;

export async function upsertWorkspace(workspaceId: string, name: string): Promise<void> {
  await db.insert(cuWorkspaces).values({ workspaceId, name }).onConflictDoUpdate({
    target: cuWorkspaces.workspaceId,
    set: { name },
  });
}

export async function upsertSpace(workspaceId: string, payload: Json): Promise<void> {
  await db.insert(cuSpaces).values({
    id: String(payload.id),
    workspaceId,
    name: String(payload.name),
    archived: Boolean(payload.archived),
  }).onConflictDoUpdate({
    target: cuSpaces.id,
    set: { name: String(payload.name), archived: Boolean(payload.archived), deletedAt: null },
  });
}

export async function upsertFolder(workspaceId: string, payload: Json): Promise<void> {
  await db.insert(cuFolders).values({
    id: String(payload.id),
    workspaceId,
    spaceId: String((payload.space as Json | undefined)?.id ?? payload.space_id),
    name: String(payload.name),
    archived: Boolean(payload.archived),
  }).onConflictDoUpdate({
    target: cuFolders.id,
    set: { name: String(payload.name), archived: Boolean(payload.archived), deletedAt: null },
  });
}

export async function upsertList(workspaceId: string, payload: Json): Promise<void> {
  await db.insert(cuLists).values({
    id: String(payload.id),
    workspaceId,
    spaceId: payload.space ? String((payload.space as Json).id) : null,
    folderId: payload.folder && (payload.folder as Json).id !== '-1' ? String((payload.folder as Json).id) : null,
    name: String(payload.name),
    archived: Boolean(payload.archived),
  }).onConflictDoUpdate({
    target: cuLists.id,
    set: { name: String(payload.name), archived: Boolean(payload.archived), deletedAt: null },
  });
}

export async function upsertMember(workspaceId: string, payload: Json): Promise<void> {
  const m = (payload.user as Json | undefined) ?? payload;
  await db.insert(cuMembers).values({
    memberId: String(m.id),
    workspaceId,
    name: m.username ? String(m.username) : null,
    email: m.email ? String(m.email) : null,
    role: m.role ? String(m.role) : null,
  }).onConflictDoUpdate({
    target: cuMembers.memberId,
    set: {
      name: m.username ? String(m.username) : null,
      email: m.email ? String(m.email) : null,
      role: m.role ? String(m.role) : null,
    },
  });
}

export async function upsertCustomField(workspaceId: string, scopeId: string, scopeType: 'list' | 'folder' | 'space', payload: Json): Promise<void> {
  await db.insert(cuCustomFields).values({
    customFieldId: String(payload.id),
    workspaceId,
    scopeId,
    scopeType,
    name: String(payload.name),
    type: String(payload.type),
    config: (payload.type_config as Record<string, unknown> | undefined) ?? {},
  }).onConflictDoUpdate({
    target: cuCustomFields.customFieldId,
    set: { name: String(payload.name), type: String(payload.type), config: (payload.type_config as Record<string, unknown> | undefined) ?? {} },
  });
}

export async function upsertTask(workspaceId: string, payload: Json): Promise<void> {
  const taskId = String(payload.id);
  const updatedAt = new Date(Number(payload.date_updated ?? payload.date_updated_ts ?? Date.now()));
  const dueDate = payload.due_date ? new Date(Number(payload.due_date)) : null;
  const startDate = payload.start_date ? new Date(Number(payload.start_date)) : null;
  const completedAt = payload.date_closed ? new Date(Number(payload.date_closed)) : null;

  await db.insert(cuTasks).values({
    taskId,
    workspaceId,
    listId: String((payload.list as Json | undefined)?.id ?? payload.list_id),
    parentTaskId: payload.parent ? String(payload.parent) : null,
    name: String(payload.name),
    description: payload.description ? String(payload.description) : null,
    status: (payload.status as Json | undefined)?.status ? String((payload.status as Json).status) : null,
    priority: payload.priority && typeof payload.priority === 'object' ? Number((payload.priority as Json).priority ?? 0) : (payload.priority != null ? Number(payload.priority) : null),
    dueDate: dueDate ? dueDate.toISOString().slice(0, 10) : null,
    startDate: startDate ? startDate.toISOString().slice(0, 10) : null,
    completedAt,
    timeEstimate: payload.time_estimate != null ? Number(payload.time_estimate) : null,
    timeSpent: payload.time_spent != null ? Number(payload.time_spent) : null,
    assignees: Array.isArray(payload.assignees) ? (payload.assignees as Json[]).map((a) => ({ id: String(a.id), name: a.username ? String(a.username) : undefined, email: a.email ? String(a.email) : undefined })) : [],
    tags: Array.isArray(payload.tags) ? (payload.tags as Json[]).map((t) => String(t.name)) : [],
    updatedAtClickup: updatedAt,
    deletedAt: null,
  }).onConflictDoUpdate({
    target: cuTasks.taskId,
    // staleness guard: only overwrite if incoming updated_at is newer
    set: {
      listId: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.list_id ELSE ${cuTasks.listId} END`,
      name: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.name ELSE ${cuTasks.name} END`,
      description: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.description ELSE ${cuTasks.description} END`,
      status: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.status ELSE ${cuTasks.status} END`,
      priority: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.priority ELSE ${cuTasks.priority} END`,
      dueDate: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.due_date ELSE ${cuTasks.dueDate} END`,
      startDate: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.start_date ELSE ${cuTasks.startDate} END`,
      completedAt: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.completed_at ELSE ${cuTasks.completedAt} END`,
      assignees: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.assignees ELSE ${cuTasks.assignees} END` as any,
      tags: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.tags ELSE ${cuTasks.tags} END` as any,
      updatedAtClickup: sql`GREATEST(excluded.updated_at_clickup, ${cuTasks.updatedAtClickup})`,
      deletedAt: sql`NULL`,
    },
  });

  // upsert custom field values
  if (Array.isArray(payload.custom_fields)) {
    for (const cf of payload.custom_fields as Json[]) {
      if (cf.value === undefined || cf.value === null) continue;
      await db.insert(cuTaskCustomFieldValues).values({
        taskId,
        customFieldId: String(cf.id),
        value: cf.value,
      }).onConflictDoUpdate({
        target: [cuTaskCustomFieldValues.taskId, cuTaskCustomFieldValues.customFieldId],
        set: { value: cf.value },
      });
    }
  }
}

export async function softDeleteTask(taskId: string): Promise<void> {
  await db.update(cuTasks).set({ deletedAt: new Date() }).where(sql`${cuTasks.taskId} = ${taskId}`);
}
