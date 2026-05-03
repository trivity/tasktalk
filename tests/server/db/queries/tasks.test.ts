import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../../../src/server/db/client.js';
import { cuWorkspaces, cuLists, cuTasks } from '../../../../src/server/db/schema.js';
import { querySnapshot } from '../../../../src/server/db/queries/tasks.js';

const SEED = Date.now();
const WS = `wsq-${SEED}`;
const LIST = `lq-${SEED}`;
const T1 = `q1-${SEED}`;
const T2 = `q2-${SEED}`;
const T3 = `q3-${SEED}`;

beforeAll(async () => {
  await db.insert(cuWorkspaces).values({ workspaceId: WS, name: 'wq' }).onConflictDoNothing();
  await db.insert(cuLists).values({ id: LIST, workspaceId: WS, name: 'lq' }).onConflictDoNothing();
  await db.insert(cuTasks).values([
    { taskId: T1, workspaceId: WS, listId: LIST, name: 'open one', status: 'open', assignees: [{ id: 'u1' }], tags: [], updatedAtClickup: new Date(), priority: 1 },
    { taskId: T2, workspaceId: WS, listId: LIST, name: 'closed', status: 'closed', assignees: [], tags: [], updatedAtClickup: new Date(), priority: 3 },
    { taskId: T3, workspaceId: WS, listId: LIST, name: 'open two', status: 'open', assignees: [{ id: 'u2' }], tags: [], updatedAtClickup: new Date(), priority: 2 },
  ]).onConflictDoNothing();
});

describe('querySnapshot', () => {
  it('filters by workspace and status', async () => {
    const r = await querySnapshot({ workspaceIds: [WS], filters: { status: ['open'] } });
    expect(r.results).toHaveLength(2);
    expect(r.data_source).toBe('snapshot');
  });

  it('filters by assignee (JSONB)', async () => {
    const r = await querySnapshot({ workspaceIds: [WS], filters: { assigneeId: 'u1' } });
    expect(r.results).toHaveLength(1);
    expect(r.results[0].task_id).toBe(T1);
  });

  it('refuses to bypass workspace boundary even if filter is empty', async () => {
    const r = await querySnapshot({ workspaceIds: ['NOPE'], filters: {} });
    expect(r.results).toHaveLength(0);
  });
});
