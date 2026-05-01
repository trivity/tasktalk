import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../../../src/server/db/client.js';
import { cuWorkspaces, cuLists, cuTasks, cuMembers } from '../../../../src/server/db/schema.js';
import { aggregateWorkload, aggregateThroughput } from '../../../../src/server/db/queries/aggregates.js';

const SEED = Date.now();
const WS = `agg-${SEED}`;
const LIST = `agg-l-${SEED}`;
const M1 = `agg-m1-${SEED}`;
const M2 = `agg-m2-${SEED}`;
const T1 = `agg-t1-${SEED}`;
const T2 = `agg-t2-${SEED}`;
const T3 = `agg-t3-${SEED}`;
const T4 = `agg-t4-${SEED}`;

beforeAll(async () => {
  await db.insert(cuWorkspaces).values({ workspaceId: WS, name: 'agg', lastIncrementalSyncAt: new Date() }).onConflictDoNothing();
  await db.insert(cuLists).values({ id: LIST, workspaceId: WS, name: 'l' }).onConflictDoNothing();
  await db.insert(cuMembers).values([
    { memberId: M1, workspaceId: WS, name: 'Alice' },
    { memberId: M2, workspaceId: WS, name: 'Bob' },
  ]).onConflictDoNothing();
  const now = Date.now();
  await db.insert(cuTasks).values([
    { taskId: T1, workspaceId: WS, listId: LIST, name: 'a-open', status: 'open', assignees: [{ id: M1 }], tags: [], updatedAtClickup: new Date() },
    { taskId: T2, workspaceId: WS, listId: LIST, name: 'a-done', status: 'closed', completedAt: new Date(now - 86400_000), assignees: [{ id: M1 }], tags: [], updatedAtClickup: new Date() },
    { taskId: T3, workspaceId: WS, listId: LIST, name: 'b-open', status: 'open', assignees: [{ id: M2 }], tags: [], updatedAtClickup: new Date() },
    { taskId: T4, workspaceId: WS, listId: LIST, name: 'b-open2', status: 'open', assignees: [{ id: M2 }], tags: [], updatedAtClickup: new Date() },
  ]).onConflictDoNothing();
});

describe('aggregates', () => {
  it('aggregateWorkload counts open tasks per assignee', async () => {
    const r = await aggregateWorkload({ workspaceId: WS, groupBy: 'assignee' });
    const map = Object.fromEntries(r.results.map((g) => [g.group_id, g.count]));
    expect(map[M1]).toBe(1);
    expect(map[M2]).toBe(2);
  });

  it('aggregateThroughput counts completions in window', async () => {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const until = new Date(Date.now() + 1 * 86400_000).toISOString().slice(0, 10);
    const r = await aggregateThroughput({ workspaceId: WS, since, until });
    expect(r.total_completed).toBe(1);
  });
});
