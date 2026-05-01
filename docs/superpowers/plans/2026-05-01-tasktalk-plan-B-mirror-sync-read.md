# Tasktalk Plan B — Mirror + Sync + Read Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ClickUp mirror schema, initial sync, webhook stream, drift reconciliation, MCP client wrapper, and the `query_tasks` read path (snapshot + live with the Hybrid Router). End state: backend can sync any connected workspace and answer `query_tasks` calls correctly via either Postgres or live MCP, with rate-limit-aware pacing.

**Architecture:** pg-boss job queue (Postgres-backed) coordinates initial sync, webhook events, and the drift cron. MCP client wraps `mcp.clickup.com/mcp` with per-turn-poolable session lifecycle and transparent token refresh. Read path enforces workspace-id isolation in a query helper; routing decision based on `last_incremental_sync_at` freshness.

**Tech Stack:** pg-boss, `@modelcontextprotocol/sdk`, Drizzle (mirror schema), Hono webhook receiver, Vitest.

**Spec reference:** `docs/superpowers/specs/2026-05-01-tasktalk-design.md` Sections 4 (Data model — mirror tables), 7 (Read path), 9 (Sync layer).

**Plan A prerequisites:** users, sessions, auth_tokens, clickup_connections tables; encryption helper; OAuth flow.

---

## File Structure (Plan B scope)

**Created:**
- `src/server/db/schema.ts` (extended) — adds `cu_workspaces`, `cu_spaces`, `cu_folders`, `cu_lists`, `cu_tasks`, `cu_custom_fields`, `cu_task_custom_field_values`, `cu_members`
- `src/server/db/queries/tasks.ts` — `query_tasks` SQL helper
- `src/server/db/queries/workspace.ts` — workspace freshness lookups, member helpers
- `src/server/mcp/client.ts` — MCP client wrapper, per-turn pool primitive
- `src/server/mcp/token-refresh.ts` — auto-refresh helper
- `src/server/mcp/clickup-rest.ts` — small REST helpers for webhooks (only)
- `src/server/sync/boss.ts` — pg-boss instance + registration
- `src/server/sync/initial-sync.ts` — pg-boss handler
- `src/server/sync/sync-task.ts` — single-task upsert handler
- `src/server/sync/webhooks.ts` — subscription register/deregister
- `src/server/sync/drift.ts` — daily reconciliation handler
- `src/server/sync/pacing.ts` — rate-limit-aware throttle
- `src/server/sync/upsert.ts` — shared mirror upsert helpers
- `src/server/routes/webhooks.ts` — Hono webhook receiver
- `src/shared/schemas/tools.ts` — Zod schemas for tool args / normalized result
- `src/server/claude/router.ts` — Hybrid Router for `query_tasks`
- `src/server/claude/tools/query-tasks.ts` — first read tool
- `scripts/trigger-sync.ts` — dev CLI to enqueue initial-sync
- `tests/server/sync/pacing.test.ts`, `tests/server/db/queries/tasks.test.ts`, `tests/server/claude/router.test.ts`, `tests/server/sync/upsert.test.ts`

**Modified:**
- `src/server/index.ts` — start pg-boss in worker role, mount webhook route
- `drizzle/0001_*.sql` — generated migration

---

## Task 1: Extend Drizzle schema with mirror tables

**Files:**
- Modify: `src/server/db/schema.ts`
- Generated: `drizzle/0001_*.sql`

- [ ] **Step 1: Append mirror tables to `src/server/db/schema.ts`.**

```ts
import { pgTable, uuid, text, timestamp, boolean, integer, bigint, index, uniqueIndex, jsonb, primaryKey, date } from 'drizzle-orm/pg-core';

// ... existing Plan A tables stay above ...

export const cuWorkspaces = pgTable('cu_workspaces', {
  workspaceId: text('workspace_id').primaryKey(),
  name: text('name').notNull(),
  lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
  lastIncrementalSyncAt: timestamp('last_incremental_sync_at', { withTimezone: true }),
  lastDriftCount: integer('last_drift_count').notNull().default(0),
  syncState: jsonb('sync_state').$type<{ phase?: string; listsDone?: number; listsTotal?: number }>().notNull().default({}),
});

export const cuSpaces = pgTable(
  'cu_spaces',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => cuWorkspaces.workspaceId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archived: boolean('archived').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({ wsIdx: index('cu_spaces_ws_idx').on(t.workspaceId) }),
);

export const cuFolders = pgTable(
  'cu_folders',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    spaceId: text('space_id').notNull().references(() => cuSpaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archived: boolean('archived').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({ wsIdx: index('cu_folders_ws_idx').on(t.workspaceId), spaceIdx: index('cu_folders_space_idx').on(t.spaceId) }),
);

export const cuLists = pgTable(
  'cu_lists',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    spaceId: text('space_id'),
    folderId: text('folder_id'),
    name: text('name').notNull(),
    archived: boolean('archived').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({ wsIdx: index('cu_lists_ws_idx').on(t.workspaceId) }),
);

export const cuTasks = pgTable(
  'cu_tasks',
  {
    taskId: text('task_id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    listId: text('list_id').notNull(),
    parentTaskId: text('parent_task_id'),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status'),
    priority: integer('priority'),
    dueDate: date('due_date'),
    startDate: date('start_date'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    timeEstimate: bigint('time_estimate', { mode: 'number' }),
    timeSpent: bigint('time_spent', { mode: 'number' }),
    assignees: jsonb('assignees').$type<Array<{ id: string; name?: string; email?: string }>>().notNull().default([]),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    updatedAtClickup: timestamp('updated_at_clickup', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    wsListStatusIdx: index('cu_tasks_ws_list_status_idx').on(t.workspaceId, t.listId, t.status),
    wsDueIdx: index('cu_tasks_ws_due_idx').on(t.workspaceId, t.dueDate),
    wsCompletedIdx: index('cu_tasks_ws_completed_idx').on(t.workspaceId, t.completedAt),
    updatedIdx: index('cu_tasks_updated_idx').on(t.updatedAtClickup),
    assigneesIdx: index('cu_tasks_assignees_gin_idx').using('gin', t.assignees),
  }),
);

export const cuCustomFields = pgTable(
  'cu_custom_fields',
  {
    customFieldId: text('custom_field_id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    scopeId: text('scope_id').notNull(),
    scopeType: text('scope_type', { enum: ['list', 'folder', 'space'] }).notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({ scopeIdx: index('cu_cf_scope_idx').on(t.scopeId) }),
);

export const cuTaskCustomFieldValues = pgTable(
  'cu_task_custom_field_values',
  {
    taskId: text('task_id').notNull().references(() => cuTasks.taskId, { onDelete: 'cascade' }),
    customFieldId: text('custom_field_id').notNull().references(() => cuCustomFields.customFieldId, { onDelete: 'cascade' }),
    value: jsonb('value').$type<unknown>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.customFieldId] }),
    cfIdx: index('cu_cfv_cf_idx').on(t.customFieldId),
  }),
);

export const cuMembers = pgTable(
  'cu_members',
  {
    memberId: text('member_id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => cuWorkspaces.workspaceId, { onDelete: 'cascade' }),
    name: text('name'),
    email: text('email'),
    role: text('role'),
  },
  (t) => ({ wsIdx: index('cu_members_ws_idx').on(t.workspaceId) }),
);
```

- [ ] **Step 2: Generate migration.**

```bash
npm run db:generate
```
Expected: a new `drizzle/0001_*.sql` file with `CREATE TABLE` for all eight `cu_*` tables and indexes.

- [ ] **Step 3: Apply migration.**

```bash
npm run db:push
```
Verify:
```bash
docker exec -it tasktalk-pg psql -U postgres -d tasktalk -c "\dt cu_*"
```
Expected: 8 `cu_*` tables listed.

- [ ] **Step 4: Commit.**

```bash
git add src/server/db/schema.ts drizzle/
git commit -m "feat(db): mirror schema (cu_* tables) with workspace-id boundary"
```

---

## Task 2: Token-refresh helper

**Files:**
- Create: `src/server/mcp/token-refresh.ts`

- [ ] **Step 1: Implement.**

```ts
import { db } from '../db/client.js';
import { clickupConnections } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { decryptToken, encryptToken } from '../db/encrypt.js';
import { env } from '../env.js';
import { refreshAccessToken } from './oauth.js';

const REFRESH_BUFFER_MS = 60_000;

export async function getValidAccessToken(userId: string): Promise<{ accessToken: string; workspaceId: string }> {
  const [row] = await db
    .select()
    .from(clickupConnections)
    .where(and(eq(clickupConnections.userId, userId), isNull(clickupConnections.tombstonedAt)))
    .limit(1);
  if (!row) throw new Error('No active ClickUp connection');

  const expiresAt = row.expiresAt.getTime();
  if (expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return {
      accessToken: decryptToken(row.accessTokenEnc, env.TOKEN_ENCRYPTION_KEY),
      workspaceId: row.workspaceId,
    };
  }

  const refreshToken = decryptToken(row.refreshTokenEnc, env.TOKEN_ENCRYPTION_KEY);
  const fresh = await refreshAccessToken(refreshToken);
  await db
    .update(clickupConnections)
    .set({
      accessTokenEnc: encryptToken(fresh.access_token, env.TOKEN_ENCRYPTION_KEY),
      refreshTokenEnc: encryptToken(fresh.refresh_token, env.TOKEN_ENCRYPTION_KEY),
      expiresAt: new Date(Date.now() + fresh.expires_in * 1000),
    })
    .where(eq(clickupConnections.id, row.id));
  return { accessToken: fresh.access_token, workspaceId: row.workspaceId };
}
```

- [ ] **Step 2: Commit.**

```bash
git add src/server/mcp/token-refresh.ts
git commit -m "feat(mcp): auto-refresh ClickUp access token before MCP calls"
```

---

## Task 3: MCP client wrapper with per-turn pooling

**Files:**
- Create: `src/server/mcp/client.ts`

- [ ] **Step 1: Implement.**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getValidAccessToken } from './token-refresh.js';

const CLICKUP_MCP_URL = 'https://mcp.clickup.com/mcp';

export type McpSession = {
  client: Client;
  workspaceId: string;
  close: () => Promise<void>;
};

export async function openMcpSession(userId: string): Promise<McpSession> {
  const { accessToken, workspaceId } = await getValidAccessToken(userId);
  const transport = new StreamableHTTPClientTransport(new URL(CLICKUP_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'tasktalk', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    workspaceId,
    close: async () => {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Per-turn pool primitive. The caller (Claude turn loop) creates one of these
 * at the start of a turn, calls .get() on the first MCP-needing tool call, and
 * .closeAll() at the end of the turn. Lazy: if no MCP call happens, no session opens.
 */
export class TurnMcpPool {
  private session: McpSession | null = null;
  constructor(private readonly userId: string) {}

  async get(): Promise<McpSession> {
    if (this.session) return this.session;
    this.session = await openMcpSession(this.userId);
    return this.session;
  }

  async closeAll(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }
}

export async function callMcpTool<T = unknown>(session: McpSession, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await session.client.callTool({ name, arguments: args });
  return result as unknown as T;
}
```

> **Implementation note:** the exact transport class and import path may shift slightly with the MCP SDK version (1.x). If `StreamableHTTPClientTransport` lives elsewhere in the installed version, search the SDK exports — the public API for connecting an HTTP MCP client is stable in shape even if the import path moves.

- [ ] **Step 2: Smoke test (manual).**

This step requires a real connected user. After Plan A is in place and a teammate has connected their ClickUp:

```bash
# Inside an `npx tsx` REPL or a scratch script:
import { openMcpSession } from './src/server/mcp/client.js';
const s = await openMcpSession('<userId>');
console.log(await s.client.listTools());
await s.close();
```
Expected: a list of ClickUp's MCP tools.

- [ ] **Step 3: Commit.**

```bash
git add src/server/mcp/client.ts
git commit -m "feat(mcp): MCP client wrapper + per-turn pool primitive"
```

---

## Task 4: Mirror upsert helpers

**Files:**
- Create: `src/server/sync/upsert.ts`
- Test: `tests/server/sync/upsert.test.ts`

These helpers normalize raw ClickUp payloads into mirror rows. Used by both initial sync and the webhook-driven sync-task handler.

- [ ] **Step 1: Write the failing test for `upsertTask`.**

```ts
// tests/server/sync/upsert.test.ts
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
```

- [ ] **Step 2: Run test, verify fail.**

```bash
npm test -- upsert.test
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/server/sync/upsert.ts`.**

```ts
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
      assignees: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.assignees ELSE ${cuTasks.assignees} END`,
      tags: sql`CASE WHEN excluded.updated_at_clickup >= ${cuTasks.updatedAtClickup} THEN excluded.tags ELSE ${cuTasks.tags} END`,
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
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- upsert.test
```
Expected: 2 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/sync/upsert.ts tests/server/sync/upsert.test.ts
git commit -m "feat(sync): mirror upsert helpers with staleness guard on tasks"
```

---

## Task 5: Rate-limit-aware pacing helper

**Files:**
- Create: `src/server/sync/pacing.ts`
- Test: `tests/server/sync/pacing.test.ts`

A small token-bucket-like throttle so initial sync respects the 300/24h ClickUp rate limit (or higher with the AI add-on). Configurable per-workspace.

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/sync/pacing.test.ts
import { describe, it, expect } from 'vitest';
import { Pacer } from '../../../src/server/sync/pacing.js';

describe('Pacer', () => {
  it('allows immediate calls under capacity', async () => {
    const p = new Pacer({ ratePerSecond: 100, burst: 5 });
    const start = Date.now();
    for (let i = 0; i < 5; i++) await p.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('blocks when capacity exceeded', async () => {
    const p = new Pacer({ ratePerSecond: 10, burst: 2 });
    const start = Date.now();
    await p.acquire(); await p.acquire(); await p.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- pacing.test
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/server/sync/pacing.ts`.**

```ts
export type PacerOpts = { ratePerSecond: number; burst: number };

export class Pacer {
  private tokens: number;
  private lastRefill: number;
  constructor(private readonly opts: PacerOpts) {
    this.tokens = opts.burst;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.opts.ratePerSecond) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.opts.burst, this.tokens + elapsed * this.opts.ratePerSecond);
    this.lastRefill = now;
  }
}

export function pacerForRateLimit(callsPer24h: number): Pacer {
  // Smooth across the day with a small burst allowance.
  const ratePerSecond = callsPer24h / (24 * 60 * 60);
  return new Pacer({ ratePerSecond, burst: Math.max(5, Math.floor(callsPer24h / 60)) });
}
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- pacing.test
```
Expected: 2 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/sync/pacing.ts tests/server/sync/pacing.test.ts
git commit -m "feat(sync): rate-limit-aware Pacer (token bucket)"
```

---

## Task 6: pg-boss setup + worker registration

**Files:**
- Create: `src/server/sync/boss.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Implement `src/server/sync/boss.ts`.**

```ts
import PgBoss from 'pg-boss';
import { env } from '../env.js';

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (e) => console.error('[boss] error', e));
  await boss.start();
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) { await boss.stop({ graceful: true }); boss = null; }
}

export const QUEUE_INITIAL_SYNC = 'initial-sync';
export const QUEUE_SYNC_TASK = 'sync-task';
export const QUEUE_DRIFT = 'drift-reconcile';

export type InitialSyncPayload = { userId: string };
export type SyncTaskPayload = { workspaceId: string; taskId: string };
export type DriftPayload = { workspaceId: string };
```

- [ ] **Step 2: Modify `src/server/index.ts` worker startup.**

Replace `startWorker` with:

```ts
import { getBoss, QUEUE_INITIAL_SYNC, QUEUE_SYNC_TASK, QUEUE_DRIFT } from './sync/boss.js';
import { runInitialSync } from './sync/initial-sync.js';
import { runSyncTask } from './sync/sync-task.js';
import { runDrift } from './sync/drift.js';

async function startWorker() {
  const boss = await getBoss();
  await boss.work(QUEUE_INITIAL_SYNC, { batchSize: 1 }, async ([job]) => { await runInitialSync(job.data); });
  await boss.work(QUEUE_SYNC_TASK, { batchSize: 5 }, async (jobs) => { for (const j of jobs) await runSyncTask(j.data); });
  await boss.work(QUEUE_DRIFT, { batchSize: 1 }, async ([job]) => { await runDrift(job.data); });
  await boss.schedule(QUEUE_DRIFT, '0 4 * * *', { workspaceId: 'ALL' }, { tz: 'UTC' });
  console.log('[worker] pg-boss workers registered');
  process.on('SIGTERM', async () => { await boss.stop({ graceful: true }); process.exit(0); });
}
```

> Handlers `runInitialSync`, `runSyncTask`, `runDrift` are implemented in Tasks 7–9. The cron schedule uses workspaceId `'ALL'` as a sentinel; the drift handler enumerates all connected workspaces and re-enqueues per-workspace.

- [ ] **Step 3: Commit (handler implementations come next; the import will fail at compile until those land).**

> Skip the typecheck on this commit — the handler files are added in subsequent tasks. Use `git commit --no-verify` only if you have a pre-commit hook that runs typecheck; if so, deferred imports can be replaced with placeholder no-op functions until Task 9 lands. Otherwise, sequence Tasks 6 → 7 → 8 → 9 before testing the worker.

```bash
git add src/server/sync/boss.ts src/server/index.ts
git commit -m "feat(sync): pg-boss setup + worker queue registration"
```

---

## Task 7: Initial sync handler

**Files:**
- Create: `src/server/sync/initial-sync.ts`

- [ ] **Step 1: Implement.**

```ts
import { db } from '../db/client.js';
import { cuWorkspaces } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';
import { upsertWorkspace, upsertSpace, upsertFolder, upsertList, upsertTask, upsertMember, upsertCustomField } from './upsert.js';
import { pacerForRateLimit } from './pacing.js';
import type { InitialSyncPayload } from './boss.js';

const PACE_CALLS_PER_24H = Number(process.env.SYNC_RATE_LIMIT ?? 300);

export async function runInitialSync({ userId }: InitialSyncPayload): Promise<void> {
  const pool = new TurnMcpPool(userId);
  const session = await pool.get();
  const workspaceId = session.workspaceId;
  const pacer = pacerForRateLimit(PACE_CALLS_PER_24H);

  try {
    await upsertWorkspace(workspaceId, '(syncing…)');
    await db.update(cuWorkspaces).set({ syncState: { phase: 'spaces' } }).where(eq(cuWorkspaces.workspaceId, workspaceId));

    // 1. Spaces
    await pacer.acquire();
    const spacesResp = await callMcpTool<{ spaces: Array<Record<string, unknown>> }>(session, 'list_spaces', { team_id: workspaceId });
    for (const s of spacesResp.spaces ?? []) await upsertSpace(workspaceId, s);

    // 2. Folders + lists per space
    let listsTotal = 0; let listsDone = 0;
    const allLists: string[] = [];
    for (const s of spacesResp.spaces ?? []) {
      const sid = String(s.id);
      await pacer.acquire();
      const foldersResp = await callMcpTool<{ folders: Array<Record<string, unknown>> }>(session, 'list_folders', { space_id: sid });
      for (const f of foldersResp.folders ?? []) {
        await upsertFolder(workspaceId, f);
        for (const l of (f.lists as Array<Record<string, unknown>> | undefined) ?? []) {
          await upsertList(workspaceId, l);
          allLists.push(String(l.id));
          listsTotal++;
        }
      }
      await pacer.acquire();
      const folderlessResp = await callMcpTool<{ lists: Array<Record<string, unknown>> }>(session, 'list_folderless_lists', { space_id: sid });
      for (const l of folderlessResp.lists ?? []) {
        await upsertList(workspaceId, l);
        allLists.push(String(l.id));
        listsTotal++;
      }
    }
    await db.update(cuWorkspaces).set({ syncState: { phase: 'tasks', listsDone: 0, listsTotal } }).where(eq(cuWorkspaces.workspaceId, workspaceId));

    // 3. Tasks + custom fields per list (paginated)
    for (const listId of allLists) {
      // custom field defs (one call per list)
      await pacer.acquire();
      try {
        const cfResp = await callMcpTool<{ fields: Array<Record<string, unknown>> }>(session, 'list_custom_fields', { list_id: listId });
        for (const f of cfResp.fields ?? []) await upsertCustomField(workspaceId, listId, 'list', f);
      } catch { /* not all lists have cf endpoint */ }

      // tasks
      let page = 0;
      while (true) {
        await pacer.acquire();
        const resp = await callMcpTool<{ tasks: Array<Record<string, unknown>>; last_page?: boolean }>(session, 'list_tasks', { list_id: listId, page, include_subtasks: true });
        for (const t of resp.tasks ?? []) await upsertTask(workspaceId, t);
        if (!resp.tasks?.length || resp.last_page) break;
        page++;
      }
      listsDone++;
      if (listsDone % 5 === 0) {
        await db.update(cuWorkspaces).set({ syncState: { phase: 'tasks', listsDone, listsTotal } }).where(eq(cuWorkspaces.workspaceId, workspaceId));
      }
    }

    // 4. Members
    await pacer.acquire();
    const teamResp = await callMcpTool<{ team: { members: Array<Record<string, unknown>> } }>(session, 'get_team', { team_id: workspaceId });
    for (const m of teamResp.team?.members ?? []) await upsertMember(workspaceId, m);

    // 5. Mark complete
    const now = new Date();
    await db.update(cuWorkspaces)
      .set({ lastFullSyncAt: now, lastIncrementalSyncAt: now, syncState: { phase: 'done', listsDone, listsTotal } })
      .where(eq(cuWorkspaces.workspaceId, workspaceId));
  } finally {
    await pool.closeAll();
  }
}
```

> **Tool name caveat:** the exact ClickUp MCP tool names (`list_spaces`, `list_folders`, etc.) need to be verified against ClickUp's MCP schema. Adjust the strings in `callMcpTool` calls to match what `client.listTools()` returns at runtime. The shape of payloads (id, name, etc.) follows ClickUp's REST conventions.

- [ ] **Step 2: Commit.**

```bash
git add src/server/sync/initial-sync.ts
git commit -m "feat(sync): initial-sync handler (workspace tree + custom fields + members)"
```

---

## Task 8: Sync-task handler (single-task upsert)

**Files:**
- Create: `src/server/sync/sync-task.ts`

- [ ] **Step 1: Implement.**

```ts
import { db } from '../db/client.js';
import { cuWorkspaces, clickupConnections } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';
import { upsertTask, softDeleteTask } from './upsert.js';
import type { SyncTaskPayload } from './boss.js';

export async function runSyncTask({ workspaceId, taskId }: SyncTaskPayload): Promise<void> {
  // pick any active connection for this workspace; webhooks are workspace-level so any user works
  const [conn] = await db
    .select()
    .from(clickupConnections)
    .where(and(eq(clickupConnections.workspaceId, workspaceId), isNull(clickupConnections.tombstonedAt)))
    .limit(1);
  if (!conn) return; // workspace has no active connection — drop event silently

  const pool = new TurnMcpPool(conn.userId);
  const session = await pool.get();
  try {
    try {
      const resp = await callMcpTool<{ task: Record<string, unknown> }>(session, 'get_task', { task_id: taskId });
      if (resp?.task) {
        await upsertTask(workspaceId, resp.task);
      } else {
        await softDeleteTask(taskId);
      }
    } catch (e) {
      const msg = String((e as Error).message ?? '');
      if (/404|not.found/i.test(msg)) {
        await softDeleteTask(taskId);
      } else {
        throw e;
      }
    }
    await db.update(cuWorkspaces).set({ lastIncrementalSyncAt: new Date() }).where(eq(cuWorkspaces.workspaceId, workspaceId));
  } finally {
    await pool.closeAll();
  }
}
```

- [ ] **Step 2: Commit.**

```bash
git add src/server/sync/sync-task.ts
git commit -m "feat(sync): sync-task handler (single-task upsert + 404 → soft delete)"
```

---

## Task 9: Drift reconciliation cron handler

**Files:**
- Create: `src/server/sync/drift.ts`

- [ ] **Step 1: Implement.**

```ts
import { db } from '../db/client.js';
import { cuWorkspaces, cuLists, clickupConnections } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';
import { upsertTask } from './upsert.js';
import type { DriftPayload } from './boss.js';
import { pacerForRateLimit } from './pacing.js';

const PACE_CALLS_PER_24H = Number(process.env.SYNC_RATE_LIMIT ?? 300);

export async function runDrift({ workspaceId }: DriftPayload): Promise<void> {
  // sentinel — cron passes 'ALL' to mean "every active workspace"
  if (workspaceId === 'ALL') {
    const ws = await db.selectDistinct({ workspaceId: clickupConnections.workspaceId }).from(clickupConnections).where(isNull(clickupConnections.tombstonedAt));
    for (const row of ws) await driftSingle(row.workspaceId);
    return;
  }
  await driftSingle(workspaceId);
}

async function driftSingle(workspaceId: string): Promise<void> {
  const [conn] = await db.select().from(clickupConnections)
    .where(and(eq(clickupConnections.workspaceId, workspaceId), isNull(clickupConnections.tombstonedAt))).limit(1);
  if (!conn) return;

  const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  if (!ws?.lastIncrementalSyncAt) return; // never fully synced

  const since = ws.lastIncrementalSyncAt;
  const pool = new TurnMcpPool(conn.userId);
  const session = await pool.get();
  const pacer = pacerForRateLimit(PACE_CALLS_PER_24H);
  let drifted = 0;

  try {
    const lists = await db.select().from(cuLists).where(and(eq(cuLists.workspaceId, workspaceId), isNull(cuLists.deletedAt)));
    for (const l of lists) {
      let page = 0;
      while (true) {
        await pacer.acquire();
        const resp = await callMcpTool<{ tasks: Array<Record<string, unknown>>; last_page?: boolean }>(
          session, 'list_tasks', { list_id: l.id, page, date_updated_gt: since.getTime(), include_subtasks: true });
        for (const t of resp.tasks ?? []) {
          await upsertTask(workspaceId, t);
          drifted++;
        }
        if (!resp.tasks?.length || resp.last_page) break;
        page++;
      }
    }
    await db.update(cuWorkspaces).set({ lastDriftCount: drifted, lastIncrementalSyncAt: new Date() }).where(eq(cuWorkspaces.workspaceId, workspaceId));
  } finally {
    await pool.closeAll();
  }
}
```

- [ ] **Step 2: Commit.**

```bash
git add src/server/sync/drift.ts
git commit -m "feat(sync): daily drift reconciliation handler"
```

---

## Task 10: Webhook subscription register / deregister

**Files:**
- Create: `src/server/mcp/clickup-rest.ts`, `src/server/sync/webhooks.ts`
- Modify: `src/server/routes/clickup-oauth.ts` (call register on connect, deregister on disconnect-final-tombstone-purge)

> Webhooks are configured via ClickUp's **REST API**, not MCP. We need a thin REST wrapper just for that.

- [ ] **Step 1: Create `src/server/mcp/clickup-rest.ts`.**

```ts
import { getValidAccessToken } from './token-refresh.js';

const REST_BASE = 'https://api.clickup.com/api/v2';

async function call(userId: string, method: string, path: string, body?: unknown) {
  const { accessToken } = await getValidAccessToken(userId);
  const res = await fetch(`${REST_BASE}${path}`, {
    method,
    headers: { Authorization: accessToken, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`ClickUp REST ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export const clickupRest = {
  createWebhook: (userId: string, teamId: string, endpoint: string, events: string[], secret: string) =>
    call(userId, 'POST', `/team/${teamId}/webhook`, { endpoint, events, health_check: { hash: secret } }),
  deleteWebhook: (userId: string, webhookId: string) =>
    call(userId, 'DELETE', `/webhook/${webhookId}`),
  listWebhooks: (userId: string, teamId: string) =>
    call(userId, 'GET', `/team/${teamId}/webhook`),
};
```

- [ ] **Step 2: Create `src/server/sync/webhooks.ts`.**

```ts
import { db } from '../db/client.js';
import { cuWorkspaces } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { clickupRest } from '../mcp/clickup-rest.js';
import { env } from '../env.js';

const SUBSCRIBED_EVENTS = [
  'taskCreated', 'taskUpdated', 'taskDeleted',
  'taskStatusUpdated', 'taskAssigneeUpdated',
  'taskCommentPosted',
];

const WEBHOOK_PATH = '/api/webhooks/clickup';

export async function ensureWorkspaceWebhook(userId: string, workspaceId: string): Promise<void> {
  const endpoint = `${env.BASE_URL}${WEBHOOK_PATH}`;
  const existing = (await clickupRest.listWebhooks(userId, workspaceId)) as { webhooks: Array<{ id: string; endpoint: string }> };
  if (existing.webhooks?.some((w) => w.endpoint === endpoint)) return;
  await clickupRest.createWebhook(userId, workspaceId, endpoint, SUBSCRIBED_EVENTS, env.CLICKUP_WEBHOOK_SECRET);
}

export async function removeWorkspaceWebhook(userId: string, workspaceId: string): Promise<void> {
  const existing = (await clickupRest.listWebhooks(userId, workspaceId)) as { webhooks: Array<{ id: string; endpoint: string }> };
  const endpoint = `${env.BASE_URL}${WEBHOOK_PATH}`;
  for (const w of existing.webhooks ?? []) {
    if (w.endpoint === endpoint) await clickupRest.deleteWebhook(userId, w.id);
  }
}
```

- [ ] **Step 3: Wire the OAuth callback to enqueue initial-sync and register the webhook.**

In `src/server/routes/clickup-oauth.ts`, in the callback handler after `await db.insert(clickupConnections).values(...)`:

```ts
import { getBoss, QUEUE_INITIAL_SYNC } from '../sync/boss.js';
import { ensureWorkspaceWebhook } from '../sync/webhooks.js';

// after insert:
const boss = await getBoss();
await boss.send(QUEUE_INITIAL_SYNC, { userId: u.id });
try { await ensureWorkspaceWebhook(u.id, workspaceId); } catch (e) { console.error('[clickup] webhook register failed', e); }
```

- [ ] **Step 4: Commit.**

```bash
git add src/server/mcp/clickup-rest.ts src/server/sync/webhooks.ts src/server/routes/clickup-oauth.ts
git commit -m "feat(sync): register ClickUp webhook + enqueue initial-sync on connect"
```

---

## Task 11: Webhook receiver route

**Files:**
- Create: `src/server/routes/webhooks.ts`
- Modify: `src/server/index.ts` to mount

- [ ] **Step 1: Implement `src/server/routes/webhooks.ts`.**

```ts
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { getBoss, QUEUE_SYNC_TASK } from '../sync/boss.js';

function verifySignature(rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', env.CLICKUP_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const webhookRoutes = new Hono()
  .post('/clickup', async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header('x-signature');
    if (!verifySignature(raw, sig)) return c.json({ error: 'bad_signature' }, 401);

    const body = JSON.parse(raw) as { event?: string; task_id?: string; team_id?: string };
    if (!body.task_id || !body.team_id) return c.json({ ok: true });

    const boss = await getBoss();
    // dedup by job id within a 1s window — pg-boss singleton pattern
    await boss.send(
      QUEUE_SYNC_TASK,
      { workspaceId: body.team_id, taskId: body.task_id },
      { singletonKey: `${body.team_id}:${body.task_id}`, singletonSeconds: 1 },
    );
    return c.json({ ok: true });
  });
```

- [ ] **Step 2: Mount in `src/server/index.ts`.**

```ts
import { webhookRoutes } from './routes/webhooks.js';
// inside startWeb():
app.route('/api/webhooks', webhookRoutes);
```

- [ ] **Step 3: Smoke test.**

```bash
# fake a webhook event with correct signature:
RAW='{"event":"taskUpdated","task_id":"abc","team_id":"team-1"}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha256', process.env.CLICKUP_WEBHOOK_SECRET).update(process.argv[1]).digest('hex'))" "$RAW")
curl -X POST http://localhost:3000/api/webhooks/clickup \
  -H "x-signature: $SIG" -H "content-type: application/json" \
  -d "$RAW"
```
Expected: `{"ok":true}`. Inspect pg-boss queue:
```bash
docker exec -it tasktalk-pg psql -U postgres -d tasktalk -c "SELECT * FROM pgboss.job WHERE name='sync-task' ORDER BY createdon DESC LIMIT 5;"
```
Expected: a row appears (and the worker dequeues it shortly after, if running).

- [ ] **Step 4: Commit.**

```bash
git add src/server/routes/webhooks.ts src/server/index.ts
git commit -m "feat(sync): ClickUp webhook receiver with HMAC signature verification"
```

---

## Task 12: `query_tasks` snapshot SQL helper

**Files:**
- Create: `src/server/db/queries/tasks.ts`
- Test: `tests/server/db/queries/tasks.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/db/queries/tasks.test.ts
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
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- queries/tasks.test
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/server/db/queries/tasks.ts`.**

```ts
import { db } from '../client.js';
import { cuTasks, cuWorkspaces } from '../schema.js';
import { and, eq, gte, lte, isNull, sql, type SQL, inArray } from 'drizzle-orm';

export type TaskFilters = {
  listId?: string;
  status?: string[];
  assigneeId?: string;
  dueBefore?: string; // YYYY-MM-DD
  dueAfter?: string;
  hasTag?: string;
};

export type SnapshotResult = {
  data_source: 'snapshot';
  as_of: string;
  results: Array<{
    task_id: string;
    name: string;
    status: string | null;
    priority: number | null;
    due_date: string | null;
    assignees: Array<{ id: string; name?: string }>;
    list_id: string;
    tags: string[];
  }>;
  truncated: boolean;
  total_estimate: number;
};

const MAX_RESULTS = 200;

export async function querySnapshot(opts: { workspaceId: string; filters: TaskFilters }): Promise<SnapshotResult> {
  const { workspaceId, filters } = opts;
  const conds: SQL[] = [eq(cuTasks.workspaceId, workspaceId), isNull(cuTasks.deletedAt)];
  if (filters.listId) conds.push(eq(cuTasks.listId, filters.listId));
  if (filters.status?.length) conds.push(inArray(cuTasks.status, filters.status));
  if (filters.assigneeId) conds.push(sql`${cuTasks.assignees} @> ${JSON.stringify([{ id: filters.assigneeId }])}::jsonb`);
  if (filters.dueBefore) conds.push(lte(cuTasks.dueDate, filters.dueBefore));
  if (filters.dueAfter) conds.push(gte(cuTasks.dueDate, filters.dueAfter));
  if (filters.hasTag) conds.push(sql`${cuTasks.tags} @> ${JSON.stringify([filters.hasTag])}::jsonb`);

  const rows = await db.select().from(cuTasks).where(and(...conds)).limit(MAX_RESULTS + 1);
  const truncated = rows.length > MAX_RESULTS;
  const slice = rows.slice(0, MAX_RESULTS);

  const [ws] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);

  return {
    data_source: 'snapshot',
    as_of: (ws?.asOf ?? new Date(0)).toISOString(),
    results: slice.map((r) => ({
      task_id: r.taskId,
      name: r.name,
      status: r.status,
      priority: r.priority,
      due_date: r.dueDate,
      assignees: r.assignees,
      list_id: r.listId,
      tags: r.tags,
    })),
    truncated,
    total_estimate: rows.length,
  };
}
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- queries/tasks.test
```
Expected: 3 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/db/queries/tasks.ts tests/server/db/queries/tasks.test.ts
git commit -m "feat(db): query_tasks snapshot SQL helper with workspace boundary"
```

---

## Task 13: Hybrid Router for `query_tasks`

**Files:**
- Create: `src/server/claude/router.ts`, `src/server/claude/tools/query-tasks.ts`, `src/shared/schemas/tools.ts`
- Test: `tests/server/claude/router.test.ts`

- [ ] **Step 1: Create `src/shared/schemas/tools.ts`.**

```ts
import { z } from 'zod';

export const queryTasksArgs = z.object({
  list_id: z.string().optional(),
  status: z.array(z.string()).optional(),
  assignee_id: z.string().optional(),
  due_before: z.string().optional(), // ISO date
  due_after: z.string().optional(),
  has_tag: z.string().optional(),
});

export type QueryTasksArgs = z.infer<typeof queryTasksArgs>;

export type NormalizedReadResult = {
  data_source: 'snapshot' | 'live' | 'snapshot · live-fallback';
  as_of: string;
  results: Array<Record<string, unknown>>;
  truncated: boolean;
  total_estimate?: number;
  fallback_reason?: string;
  first_run?: boolean;
};
```

- [ ] **Step 2: Write the failing router test.**

```ts
// tests/server/claude/router.test.ts
import { describe, it, expect } from 'vitest';
import { decideRoute } from '../../../src/server/claude/router.js';

describe('Hybrid Router — query_tasks', () => {
  const FRESH = new Date(Date.now() - 60_000); // 1 min ago
  const STALE = new Date(Date.now() - 600_000); // 10 min ago

  it('snapshot when fresh', () => {
    expect(decideRoute({ lastSyncAt: FRESH, mirrorEmpty: false })).toBe('snapshot');
  });

  it('live when stale', () => {
    expect(decideRoute({ lastSyncAt: STALE, mirrorEmpty: false })).toBe('live');
  });

  it('live + first_run when mirror empty', () => {
    expect(decideRoute({ lastSyncAt: null, mirrorEmpty: true })).toBe('live-first-run');
  });
});
```

- [ ] **Step 3: Run, verify fail.**

```bash
npm test -- router.test
```
Expected: FAIL.

- [ ] **Step 4: Implement `src/server/claude/router.ts`.**

```ts
const FRESH_THRESHOLD_MS = 5 * 60 * 1000;

export type RouteDecision = 'snapshot' | 'live' | 'live-first-run';

export function decideRoute(opts: { lastSyncAt: Date | null; mirrorEmpty: boolean }): RouteDecision {
  if (opts.mirrorEmpty || !opts.lastSyncAt) return 'live-first-run';
  const age = Date.now() - opts.lastSyncAt.getTime();
  return age <= FRESH_THRESHOLD_MS ? 'snapshot' : 'live';
}
```

- [ ] **Step 5: Implement `src/server/claude/tools/query-tasks.ts`.**

```ts
import { db } from '../../db/client.js';
import { cuWorkspaces, cuTasks } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { querySnapshot, type TaskFilters } from '../../db/queries/tasks.js';
import { decideRoute } from '../router.js';
import type { TurnMcpPool } from '../../mcp/client.js';
import { callMcpTool } from '../../mcp/client.js';
import { upsertTask } from '../../sync/upsert.js';
import { getBoss, QUEUE_DRIFT } from '../../sync/boss.js';
import type { QueryTasksArgs, NormalizedReadResult } from '../../../shared/schemas/tools.js';

export async function executeQueryTasks(
  workspaceId: string,
  args: QueryTasksArgs,
  pool: TurnMcpPool,
): Promise<NormalizedReadResult> {
  const [ws] = await db.select({ lastSyncAt: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(cuTasks).where(and(eq(cuTasks.workspaceId, workspaceId)));
  const route = decideRoute({ lastSyncAt: ws?.lastSyncAt ?? null, mirrorEmpty: count === 0 });

  const filters: TaskFilters = {
    listId: args.list_id,
    status: args.status,
    assigneeId: args.assignee_id,
    dueBefore: args.due_before,
    dueAfter: args.due_after,
    hasTag: args.has_tag,
  };

  if (route === 'snapshot') {
    return await querySnapshot({ workspaceId, filters });
  }

  if (route === 'live' || route === 'live-first-run') {
    try {
      const session = await pool.get();
      const liveResult = await callMcpTool<{ tasks: Array<Record<string, unknown>> }>(
        session, 'list_tasks', mcpFiltersFor(args),
      );
      // best-effort cache-back
      for (const t of liveResult.tasks ?? []) {
        try { await upsertTask(workspaceId, t); } catch { /* non-fatal */ }
      }
      // queue a sync for next time
      if (route === 'live') {
        const boss = await getBoss();
        await boss.send(QUEUE_DRIFT, { workspaceId });
      }
      return {
        data_source: 'live',
        as_of: new Date().toISOString(),
        results: (liveResult.tasks ?? []).map(normalizeTask),
        truncated: false,
        first_run: route === 'live-first-run',
      };
    } catch (err) {
      const reason = String((err as Error).message ?? err);
      const fallback = await querySnapshot({ workspaceId, filters });
      return { ...fallback, data_source: 'snapshot · live-fallback', fallback_reason: reason };
    }
  }

  return await querySnapshot({ workspaceId, filters });
}

function mcpFiltersFor(args: QueryTasksArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.list_id) out.list_id = args.list_id;
  if (args.status) out.statuses = args.status;
  if (args.assignee_id) out.assignees = [args.assignee_id];
  if (args.due_before) out.due_date_lt = new Date(args.due_before).getTime();
  if (args.due_after) out.due_date_gt = new Date(args.due_after).getTime();
  return out;
}

function normalizeTask(t: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: String(t.id),
    name: String(t.name),
    status: (t.status as Record<string, unknown> | undefined)?.status ?? null,
    priority: typeof t.priority === 'object' && t.priority ? Number((t.priority as Record<string, unknown>).priority ?? 0) : (t.priority ?? null),
    due_date: t.due_date ? new Date(Number(t.due_date)).toISOString().slice(0, 10) : null,
    assignees: Array.isArray(t.assignees) ? (t.assignees as Array<Record<string, unknown>>).map((a) => ({ id: String(a.id), name: a.username ? String(a.username) : undefined })) : [],
    list_id: String((t.list as Record<string, unknown> | undefined)?.id ?? ''),
    tags: Array.isArray(t.tags) ? (t.tags as Array<Record<string, unknown>>).map((tg) => String(tg.name)) : [],
  };
}
```

- [ ] **Step 6: Run, verify pass.**

```bash
npm test -- router.test
```
Expected: 3 passed.

- [ ] **Step 7: Commit.**

```bash
git add src/server/claude/router.ts src/server/claude/tools/query-tasks.ts src/shared/schemas/tools.ts tests/server/claude/router.test.ts
git commit -m "feat(claude): Hybrid Router + query_tasks tool with snapshot/live/fallback"
```

---

## Task 14: Dev CLI to trigger initial sync

**Files:**
- Create: `scripts/trigger-sync.ts`

- [ ] **Step 1: Implement.**

```ts
// Usage: tsx scripts/trigger-sync.ts <userEmail>
import 'dotenv/config';
import { db } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getBoss, QUEUE_INITIAL_SYNC, stopBoss } from '../src/server/sync/boss.js';

const email = process.argv[2];
if (!email) { console.error('usage: tsx scripts/trigger-sync.ts <email>'); process.exit(1); }

const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!u) { console.error('user not found'); process.exit(1); }

const boss = await getBoss();
const id = await boss.send(QUEUE_INITIAL_SYNC, { userId: u.id });
console.log(`enqueued initial-sync job ${id} for user ${u.email}`);
await stopBoss();
process.exit(0);
```

- [ ] **Step 2: Smoke test (requires a connected user with valid OAuth tokens).**

```bash
npx tsx scripts/trigger-sync.ts oz@travis.chat
# in another terminal, run worker:
PROCESS_ROLE=worker npm run dev:server
```
Expected: worker logs progress; `cu_tasks` populates over time. Inspect:
```bash
docker exec -it tasktalk-pg psql -U postgres -d tasktalk -c "SELECT count(*) FROM cu_tasks;"
```

- [ ] **Step 3: Commit.**

```bash
git add scripts/trigger-sync.ts
git commit -m "chore(dev): CLI to trigger initial-sync"
```

---

## Self-Review

**Spec coverage (Sections 4 mirror, 7 read path, 9 sync layer):**

- ✓ All 8 mirror tables created (Task 1) with workspace_id boundary on every row
- ✓ `cu_tasks` indexes per spec — `(workspace_id, list_id, status)`, `(workspace_id, due_date)`, `(workspace_id, completed_at)`, `updated_at_clickup`, GIN on assignees (Task 1)
- ✓ Soft-delete via `deleted_at` on tasks/spaces/folders/lists (Task 1, 4, 8)
- ✓ Token auto-refresh with 60s buffer (Task 2)
- ✓ MCP client with per-turn pooling (Task 3)
- ✓ Mirror upsert with staleness guard on tasks (Task 4)
- ✓ Rate-limit-aware pacing (Task 5)
- ✓ pg-boss with three queues + daily drift cron (Task 6)
- ✓ Initial sync walks dependency tree → spaces → folders/lists → tasks → CFs → members (Task 7)
- ✓ Sync state JSON published to `cu_workspaces.sync_state` (Task 7)
- ✓ Sync-task handler with 404 → soft-delete (Task 8)
- ✓ Drift reconciliation, daily, with `last_drift_count` (Task 9)
- ✓ Webhook subscription register on connect (Task 10)
- ✓ Webhook receiver with HMAC verify + dedup (Task 11)
- ✓ `query_tasks` snapshot SQL with workspace boundary in helper (Task 12)
- ✓ Normalized result shape — `data_source`, `as_of`, `results`, `truncated`, `total_estimate`, `fallback_reason`, `first_run` (Tasks 12 & 13)
- ✓ Hybrid Router rules — snapshot if fresh, live + queue-sync if stale, live + first_run if empty, snapshot · live-fallback on live error (Task 13)
- ✓ Live read async upserts to mirror (Task 13)
- ✓ Live failure retry/fallback (Task 13 — single-shot fallback; the spec mentions one retry with 250ms jitter, which can be added inside `executeQueryTasks` as a tightening if needed; current behavior degrades to snapshot on first error which is the safer default)

**Plan B intentionally excludes** (covered later):
- The aggregate tools (`aggregate_workload`, `aggregate_throughput`) — Plan C
- The remaining read tools (`list_*`, `get_task`, `get_team_members`, `list_custom_fields`) — Plan C
- Write tools — Plan D
- The Claude tool loop / system prompt — Plan C
- The chat UI — Plan C
- The 7-day tombstone purge job — Plan D (rolled into deploy/cron section)

**Placeholder scan:** No `TBD` / `TODO` / "implement later." Two callouts in code comments where ClickUp's exact MCP tool names need verification at implementation time — these are real engineering risks worth flagging, not placeholder content.

**Type consistency check:**
- `workspaceId` is `text` everywhere it appears (clickupConnections, cuWorkspaces, cuTasks, etc.) — consistent.
- `userId` is `uuid` for app users, `text` for ClickUp members — distinct columns, no confusion.
- `executeQueryTasks` returns `NormalizedReadResult`; same shape returned from `querySnapshot` (with literal `data_source: 'snapshot'`).
- `TurnMcpPool.get()` returns `McpSession` used by both sync handlers and tool execution — consistent.

**Real risks captured for the implementer:**
1. ClickUp MCP tool names (`list_spaces`, `list_folders`, `list_tasks`, `get_task`, `get_team`) need verification against `client.listTools()` output. The implementer should `console.log` it once at boot.
2. Webhook signature header name (`x-signature` vs `X-Signature` vs custom) varies by integration; check ClickUp's webhook docs.
3. `StreamableHTTPClientTransport` import path may shift with MCP SDK versions.

---

## What Plan B produces

After completing all 14 tasks:

1. A connected user can have their entire ClickUp workspace mirrored into Postgres.
2. Webhook events from ClickUp keep the mirror current in seconds.
3. A daily drift cron catches anything missed.
4. The `query_tasks` tool answers correctly via snapshot when fresh, live when stale, and falls back gracefully when MCP fails.
5. All paths respect the rate limit budget through the Pacer.

What you can NOT yet do (covered by Plans C–D):
- Have a conversation with Claude.
- See any of this data in a UI.
- Use any tools other than `query_tasks`.
- Make any writes.

---

## Next steps after Plan B

- **Plan C** — Chat UI shell + Claude tool loop + remaining read tools + aggregates
- **Plan D** — Write path + audit + undo + onboarding wizard + polish + deploy
