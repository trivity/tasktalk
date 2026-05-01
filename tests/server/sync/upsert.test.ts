import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../../src/server/db/client.js';
import { cuWorkspaces, cuLists, cuTasks } from '../../../src/server/db/schema.js';
import { upsertTask } from '../../../src/server/sync/upsert.js';
import { eq } from 'drizzle-orm';

const WS = `ws-${Date.now()}`;
const LIST = `list-${Date.now()}`;

beforeAll(async () => {
  await db.insert(cuWorkspaces).values({ workspaceId: WS, name: 'test' }).onConflictDoNothing();
  await db.insert(cuLists).values({ id: LIST, workspaceId: WS, name: 'list' }).onConflictDoNothing();
});

describe('upsertTask', () => {
  it('inserts then updates a task', async () => {
    const payload = {
      id: 't1', name: 'first',
      list: { id: LIST }, status: { status: 'open' },
      assignees: [], tags: [],
      date_updated: String(Date.now()),
    };
    await upsertTask(WS, payload);
    let [row] = await db.select().from(cuTasks).where(eq(cuTasks.taskId, 't1')).limit(1);
    expect(row.name).toBe('first');

    payload.name = 'second';
    payload.date_updated = String(Date.now() + 1000);
    await upsertTask(WS, payload);
    [row] = await db.select().from(cuTasks).where(eq(cuTasks.taskId, 't1')).limit(1);
    expect(row.name).toBe('second');
  });

  it('does not overwrite a newer mirror row with a stale payload', async () => {
    const newer = { id: 't2', name: 'new', list: { id: LIST }, status: { status: 'open' }, assignees: [], tags: [], date_updated: String(Date.now() + 10000) };
    const stale = { ...newer, name: 'stale', date_updated: String(Date.now()) };
    await upsertTask(WS, newer);
    await upsertTask(WS, stale);
    const [row] = await db.select().from(cuTasks).where(eq(cuTasks.taskId, 't2')).limit(1);
    expect(row.name).toBe('new');
  });
});
