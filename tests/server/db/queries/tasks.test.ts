import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../../../src/server/db/client.js';
import { cuWorkspaces, cuLists, cuTasks } from '../../../../src/server/db/schema.js';
import { querySnapshot } from '../../../../src/server/db/queries/tasks.js';

const WS = `wsq-${Date.now()}`;
const LIST = `lq-${Date.now()}`;

beforeAll(async () => {
  await db.insert(cuWorkspaces).values({ workspaceId: WS, name: 'wq' }).onConflictDoNothing();
  await db.insert(cuLists).values({ id: LIST, workspaceId: WS, name: 'lq' }).onConflictDoNothing();
  await db.insert(cuTasks).values([
    { taskId: 'q1', workspaceId: WS, listId: LIST, name: 'open one', status: 'open', assignees: [{ id: 'u1' }], tags: [], updatedAtClickup: new Date(), priority: 1 },
    { taskId: 'q2', workspaceId: WS, listId: LIST, name: 'closed', status: 'closed', assignees: [], tags: [], updatedAtClickup: new Date(), priority: 3 },
    { taskId: 'q3', workspaceId: WS, listId: LIST, name: 'open two', status: 'open', assignees: [{ id: 'u2' }], tags: [], updatedAtClickup: new Date(), priority: 2 },
  ]).onConflictDoNothing();
});

describe('querySnapshot', () => {
  it('filters by workspace and status', async () => {
    const r = await querySnapshot({ workspaceId: WS, filters: { status: ['open'] } });
    expect(r.results).toHaveLength(2);
    expect(r.data_source).toBe('snapshot');
  });

  it('filters by assignee (JSONB)', async () => {
    const r = await querySnapshot({ workspaceId: WS, filters: { assigneeId: 'u1' } });
    expect(r.results).toHaveLength(1);
    expect(r.results[0].task_id).toBe('q1');
  });

  it('refuses to bypass workspace boundary even if filter is empty', async () => {
    const r = await querySnapshot({ workspaceId: 'NOPE', filters: {} });
    expect(r.results).toHaveLength(0);
  });
});
