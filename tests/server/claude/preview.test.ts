import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../../src/server/db/client.js';
import { cuWorkspaces, cuLists, cuTasks } from '../../../src/server/db/schema.js';
import { buildPreview } from '../../../src/server/claude/preview.js';

const SEED = Date.now();
const WS = `pv-${SEED}`;
const LIST = `pv-l-${SEED}`;
const TASK = `pv-t1-${SEED}`;

beforeAll(async () => {
  await db.insert(cuWorkspaces).values({ workspaceId: WS, name: 'pv', lastIncrementalSyncAt: new Date() }).onConflictDoNothing();
  await db.insert(cuLists).values({ id: LIST, workspaceId: WS, name: 'l' }).onConflictDoNothing();
  await db.insert(cuTasks).values({
    taskId: TASK, workspaceId: WS, listId: LIST, name: 'Old name', status: 'open',
    assignees: [], tags: [], updatedAtClickup: new Date(), priority: 2,
  }).onConflictDoNothing();
});

describe('buildPreview', () => {
  it('builds an update_task diff', async () => {
    const p = await buildPreview({
      workspaceIds: [WS], toolName: 'update_task',
      args: { task_id: TASK, patch: { name: 'New name', status: 'closed' } },
    });
    expect(p.kind).toBe('update_task');
    expect(p.target.name).toBe('Old name');
    const fieldByKey = Object.fromEntries(p.fields.map((f) => [f.key, f]));
    expect(fieldByKey.name).toEqual({ key: 'name', before: 'Old name', after: 'New name' });
    expect(fieldByKey.status).toEqual({ key: 'status', before: 'open', after: 'closed' });
  });

  it('builds a create_task preview', async () => {
    const p = await buildPreview({
      workspaceIds: [WS], toolName: 'create_task',
      args: { list_id: LIST, name: 'Brand new', due_date: '2026-05-08' },
    });
    expect(p.kind).toBe('create_task');
    expect(p.fields.find((f) => f.key === 'name')?.after).toBe('Brand new');
  });

  it('builds a delete_task preview with destructive flag', async () => {
    const p = await buildPreview({
      workspaceIds: [WS], toolName: 'delete_task',
      args: { task_id: TASK },
    });
    expect(p.kind).toBe('delete_task');
    expect(p.destructive).toBe(true);
    expect(p.target.name).toBe('Old name');
  });

  it('builds an add_comment preview', async () => {
    const p = await buildPreview({
      workspaceIds: [WS], toolName: 'add_comment',
      args: { task_id: TASK, text: 'Looks good to me.' },
    });
    expect(p.kind).toBe('add_comment');
    expect(p.fields.find((f) => f.key === 'text')?.after).toBe('Looks good to me.');
  });
});
