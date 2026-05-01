# Tasktalk Plan C — Chat UI + Claude Tool Loop + Read Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the conversational layer end-to-end. A signed-in, ClickUp-connected user opens the chat UI, types a question, and gets a streamed Claude answer that uses Postgres-backed mirror data plus live MCP fallback through the router. All read tools, both aggregate tools, and the chat shell ship in this plan.

**Architecture:** Conversations + messages persisted in Postgres (Plan B added the schema; this plan adds the tables they live in). Backend turn loop runs the Anthropic raw SDK with tool definitions and streams via SSE. Frontend is React + TanStack Query + an SSE consumer hook. All read tools route through the same `executeTool` dispatcher that pulls from snapshot or live MCP.

**Tech Stack:** `@anthropic-ai/sdk`, Hono SSE helper, React 18, EventSource (or fetch + ReadableStream). Adds `conversations`, `messages`, `tool_calls` tables to the schema.

**Spec reference:** `docs/superpowers/specs/2026-05-01-tasktalk-design.md` Sections 4 (chat tables), 6 (Conversational layer + Router), 10 (UI/UX).

**Plan A + B prerequisites:** authenticated app, ClickUp OAuth, mirror sync, MCP client, `query_tasks` tool.

---

## File Structure (Plan C scope)

**Created:**
- `src/server/db/schema.ts` (extended) — adds `conversations`, `messages`, `tool_calls`
- `src/server/db/queries/conversations.ts` — CRUD helpers
- `src/server/db/queries/aggregates.ts` — workload + throughput SQL
- `src/server/claude/system-prompt.ts` — prompt builder with workspace summary + freshness
- `src/server/claude/tools-registry.ts` — Anthropic tool definitions (12 tools, but only 7 read tools active in Plan C)
- `src/server/claude/tools/list-org.ts`, `tools/get-task.ts`, `tools/get-team-members.ts`, `tools/list-custom-fields.ts`, `tools/aggregate-workload.ts`, `tools/aggregate-throughput.ts`, `tools/list-workspaces.ts`
- `src/server/claude/execute-tool.ts` — dispatcher that routes a tool name + args to the right handler and stamps `tool_calls`
- `src/server/claude/turn-loop.ts` — orchestrates user-message → Claude → tools → final text, streams via SSE
- `src/server/claude/client.ts` — Anthropic SDK wrapper with prompt caching
- `src/server/routes/conversations.ts` — list/get/create/rename/delete conversations
- `src/server/routes/chat.ts` — POST `/api/chat/:conversationId/turn` (SSE)
- `src/web/routes/chat.tsx` — main chat page
- `src/web/components/chat/MessageStream.tsx`, `Composer.tsx`, `ToolCallPill.tsx`, `SystemEvent.tsx` (placeholder for Plan D)
- `src/web/components/sidebar/ConversationList.tsx`, `UserMenu.tsx`
- `src/web/hooks/use-conversations.ts`, `use-message-stream.ts`, `use-theme.ts`
- `src/web/lib/sse.ts` — fetch-based SSE consumer with cookie auth
- `tests/server/claude/system-prompt.test.ts`, `tests/server/db/queries/aggregates.test.ts`, `tests/server/claude/execute-tool.test.ts`

**Modified:**
- `src/server/index.ts` — mount conversations + chat routes
- `src/web/App.tsx` — add `/chat` and `/chat/:id` routes
- `src/web/lib/rpc.ts` — extend with chat APIs

---

## Task 1: Schema for conversations + messages + tool_calls

**Files:**
- Modify: `src/server/db/schema.ts`
- Generated: `drizzle/0002_*.sql`

- [ ] **Step 1: Append to `src/server/db/schema.ts`.**

```ts
// (existing imports + tables stay above)

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New conversation'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index('conversations_user_idx').on(t.userId, t.lastMessageAt) }),
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'tool', 'system_event'] }).notNull(),
    content: jsonb('content').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ convIdx: index('messages_conv_idx').on(t.conversationId, t.createdAt) }),
);

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<unknown>(),
    routerPath: text('router_path', { enum: ['snapshot', 'live', 'snapshot · live-fallback', 'none'] }).notNull().default('none'),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ msgIdx: index('tool_calls_msg_idx').on(t.messageId) }),
);
```

- [ ] **Step 2: Generate + apply migration.**

```bash
npm run db:generate
npm run db:push
```
Verify:
```bash
docker exec -it tasktalk-pg psql -U postgres -d tasktalk -c "\dt conversations messages tool_calls"
```
Expected: 3 tables.

- [ ] **Step 3: Commit.**

```bash
git add src/server/db/schema.ts drizzle/
git commit -m "feat(db): conversations + messages + tool_calls schema"
```

---

## Task 2: Conversation queries + routes

**Files:**
- Create: `src/server/db/queries/conversations.ts`, `src/server/routes/conversations.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Implement `src/server/db/queries/conversations.ts`.**

```ts
import { db } from '../client.js';
import { conversations, messages } from '../schema.js';
import { and, eq, desc } from 'drizzle-orm';

export async function listConversations(userId: string) {
  return await db.select().from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastMessageAt));
}

export async function getConversation(userId: string, id: string) {
  const [row] = await db.select().from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId))).limit(1);
  return row ?? null;
}

export async function createConversation(userId: string, title = 'New conversation') {
  const [row] = await db.insert(conversations).values({ userId, title }).returning();
  return row!;
}

export async function renameConversation(userId: string, id: string, title: string) {
  await db.update(conversations).set({ title })
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
}

export async function deleteConversation(userId: string, id: string) {
  await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
}

export async function listMessages(userId: string, conversationId: string) {
  // verify conv ownership first
  const conv = await getConversation(userId, conversationId);
  if (!conv) return null;
  return await db.select().from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}

export async function bumpLastMessageAt(conversationId: string) {
  await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
}
```

- [ ] **Step 2: Implement `src/server/routes/conversations.ts`.**

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  listConversations, getConversation, createConversation,
  renameConversation, deleteConversation, listMessages,
} from '../db/queries/conversations.js';

const renameBody = z.object({ title: z.string().min(1).max(200) });

export const conversationRoutes = new Hono()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const u = c.get('user');
    const rows = await listConversations(u.id);
    return c.json({ conversations: rows });
  })
  .post('/', async (c) => {
    const u = c.get('user');
    const conv = await createConversation(u.id);
    return c.json({ conversation: conv });
  })
  .get('/:id', async (c) => {
    const u = c.get('user');
    const conv = await getConversation(u.id, c.req.param('id'));
    if (!conv) return c.json({ error: 'not_found' }, 404);
    return c.json({ conversation: conv });
  })
  .patch('/:id', zValidator('json', renameBody), async (c) => {
    const u = c.get('user');
    await renameConversation(u.id, c.req.param('id'), c.req.valid('json').title);
    return c.json({ ok: true });
  })
  .delete('/:id', async (c) => {
    const u = c.get('user');
    await deleteConversation(u.id, c.req.param('id'));
    return c.json({ ok: true });
  })
  .get('/:id/messages', async (c) => {
    const u = c.get('user');
    const msgs = await listMessages(u.id, c.req.param('id'));
    if (msgs === null) return c.json({ error: 'not_found' }, 404);
    return c.json({ messages: msgs });
  });
```

- [ ] **Step 3: Mount in `src/server/index.ts`.**

```ts
import { conversationRoutes } from './routes/conversations.js';
// inside startWeb(): app.route('/api/conversations', conversationRoutes);
```

- [ ] **Step 4: Commit.**

```bash
git add src/server/db/queries/conversations.ts src/server/routes/conversations.ts src/server/index.ts
git commit -m "feat(api): conversation CRUD routes"
```

---

## Task 3: Aggregate SQL helpers (workload + throughput)

**Files:**
- Create: `src/server/db/queries/aggregates.ts`
- Test: `tests/server/db/queries/aggregates.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/db/queries/aggregates.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../../../src/server/db/client.js';
import { cuWorkspaces, cuLists, cuTasks, cuMembers } from '../../../../src/server/db/schema.js';
import { aggregateWorkload, aggregateThroughput } from '../../../../src/server/db/queries/aggregates.js';

const WS = `agg-${Date.now()}`;
const LIST = `agg-l-${Date.now()}`;

beforeAll(async () => {
  await db.insert(cuWorkspaces).values({ workspaceId: WS, name: 'agg', lastIncrementalSyncAt: new Date() }).onConflictDoNothing();
  await db.insert(cuLists).values({ id: LIST, workspaceId: WS, name: 'l' }).onConflictDoNothing();
  await db.insert(cuMembers).values([
    { memberId: 'm1', workspaceId: WS, name: 'Alice' },
    { memberId: 'm2', workspaceId: WS, name: 'Bob' },
  ]).onConflictDoNothing();
  const now = Date.now();
  await db.insert(cuTasks).values([
    { taskId: 'agg-t1', workspaceId: WS, listId: LIST, name: 'a-open', status: 'open', assignees: [{ id: 'm1' }], tags: [], updatedAtClickup: new Date() },
    { taskId: 'agg-t2', workspaceId: WS, listId: LIST, name: 'a-done', status: 'closed', completedAt: new Date(now - 86400_000), assignees: [{ id: 'm1' }], tags: [], updatedAtClickup: new Date() },
    { taskId: 'agg-t3', workspaceId: WS, listId: LIST, name: 'b-open', status: 'open', assignees: [{ id: 'm2' }], tags: [], updatedAtClickup: new Date() },
    { taskId: 'agg-t4', workspaceId: WS, listId: LIST, name: 'b-open2', status: 'open', assignees: [{ id: 'm2' }], tags: [], updatedAtClickup: new Date() },
  ]).onConflictDoNothing();
});

describe('aggregates', () => {
  it('aggregateWorkload counts open tasks per assignee', async () => {
    const r = await aggregateWorkload({ workspaceId: WS, groupBy: 'assignee' });
    const map = Object.fromEntries(r.results.map((g) => [g.group_id, g.count]));
    expect(map['m1']).toBe(1);
    expect(map['m2']).toBe(2);
  });

  it('aggregateThroughput counts completions in window', async () => {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const until = new Date(Date.now() + 1 * 86400_000).toISOString().slice(0, 10);
    const r = await aggregateThroughput({ workspaceId: WS, since, until });
    expect(r.total_completed).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- queries/aggregates.test
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/db/queries/aggregates.ts`.**

```ts
import { db } from '../client.js';
import { cuTasks, cuWorkspaces, cuMembers } from '../schema.js';
import { sql } from 'drizzle-orm';

const OPEN_STATUS_PREDICATE = sql`(${cuTasks.status} IS NULL OR ${cuTasks.status} NOT IN ('closed', 'done', 'cancelled'))`;

export type WorkloadResult = {
  data_source: 'snapshot';
  as_of: string;
  results: Array<{ group_id: string; group_name: string | null; count: number; total_estimate_ms: number; max_due_date: string | null }>;
};

export async function aggregateWorkload(opts: { workspaceId: string; groupBy: 'assignee' | 'list' | 'space' }): Promise<WorkloadResult> {
  const ws = opts.workspaceId;
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(sql`${cuWorkspaces.workspaceId} = ${ws}`).limit(1);

  if (opts.groupBy === 'assignee') {
    const rows = await db.execute(sql`
      WITH unrolled AS (
        SELECT (a->>'id') AS assignee_id, t.time_estimate, t.due_date, t.task_id
        FROM cu_tasks t, jsonb_array_elements(t.assignees) a
        WHERE t.workspace_id = ${ws}
          AND t.deleted_at IS NULL
          AND (t.status IS NULL OR t.status NOT IN ('closed', 'done', 'cancelled'))
      )
      SELECT u.assignee_id AS group_id,
             m.name AS group_name,
             COUNT(*)::int AS count,
             COALESCE(SUM(u.time_estimate), 0)::bigint AS total_estimate_ms,
             MAX(u.due_date)::text AS max_due_date
      FROM unrolled u
      LEFT JOIN cu_members m ON m.member_id = u.assignee_id AND m.workspace_id = ${ws}
      GROUP BY u.assignee_id, m.name
      ORDER BY COUNT(*) DESC
    `);
    return {
      data_source: 'snapshot',
      as_of: (w?.asOf ?? new Date(0)).toISOString(),
      results: (rows as unknown as Array<{ group_id: string; group_name: string | null; count: number; total_estimate_ms: string | number; max_due_date: string | null }>).map((r) => ({
        group_id: r.group_id,
        group_name: r.group_name,
        count: Number(r.count),
        total_estimate_ms: Number(r.total_estimate_ms),
        max_due_date: r.max_due_date,
      })),
    };
  }

  // group by list or space
  const groupCol = opts.groupBy === 'list' ? sql`${cuTasks.listId}` : sql`(SELECT space_id FROM cu_lists WHERE id = ${cuTasks.listId})`;
  const rows = await db.execute(sql`
    SELECT ${groupCol} AS group_id,
           COUNT(*)::int AS count,
           COALESCE(SUM(time_estimate), 0)::bigint AS total_estimate_ms,
           MAX(due_date)::text AS max_due_date
    FROM cu_tasks
    WHERE workspace_id = ${ws}
      AND deleted_at IS NULL
      AND (status IS NULL OR status NOT IN ('closed', 'done', 'cancelled'))
    GROUP BY ${groupCol}
    ORDER BY COUNT(*) DESC
  `);
  return {
    data_source: 'snapshot',
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    results: (rows as unknown as Array<{ group_id: string; count: number; total_estimate_ms: string | number; max_due_date: string | null }>).map((r) => ({
      group_id: r.group_id,
      group_name: null,
      count: Number(r.count),
      total_estimate_ms: Number(r.total_estimate_ms),
      max_due_date: r.max_due_date,
    })),
  };
}

export type ThroughputResult = {
  data_source: 'snapshot';
  as_of: string;
  total_completed: number;
  by_day: Array<{ day: string; count: number }>;
};

export async function aggregateThroughput(opts: { workspaceId: string; since: string; until: string }): Promise<ThroughputResult> {
  const ws = opts.workspaceId;
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(sql`${cuWorkspaces.workspaceId} = ${ws}`).limit(1);

  const rows = await db.execute(sql`
    SELECT to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM cu_tasks
    WHERE workspace_id = ${ws}
      AND deleted_at IS NULL
      AND completed_at IS NOT NULL
      AND completed_at >= ${opts.since}::timestamp
      AND completed_at <= ${opts.until}::timestamp
    GROUP BY 1 ORDER BY 1
  `);

  const byDay = (rows as unknown as Array<{ day: string; count: number }>).map((r) => ({ day: r.day, count: Number(r.count) }));
  return {
    data_source: 'snapshot',
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    total_completed: byDay.reduce((s, r) => s + r.count, 0),
    by_day: byDay,
  };
}
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- queries/aggregates.test
```
Expected: 2 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/db/queries/aggregates.ts tests/server/db/queries/aggregates.test.ts
git commit -m "feat(db): aggregate_workload + aggregate_throughput SQL helpers"
```

---

## Task 4: Remaining read tool implementations

**Files:**
- Create: `src/server/claude/tools/list-org.ts`, `tools/get-task.ts`, `tools/get-team-members.ts`, `tools/list-custom-fields.ts`, `tools/list-workspaces.ts`, `tools/aggregate-workload.ts`, `tools/aggregate-throughput.ts`

Each is a thin wrapper that pulls from the appropriate snapshot or MCP source and returns a `NormalizedReadResult` (or aggregate-specific shape) consumed by the turn loop.

- [ ] **Step 1: Implement `tools/list-workspaces.ts`.**

```ts
import { db } from '../../db/client.js';
import { cuWorkspaces } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export async function executeListWorkspaces(workspaceId: string) {
  const [w] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  return {
    data_source: 'snapshot' as const,
    as_of: (w?.lastIncrementalSyncAt ?? new Date(0)).toISOString(),
    results: w ? [{ workspace_id: w.workspaceId, name: w.name }] : [],
    truncated: false,
  };
}
```

- [ ] **Step 2: Implement `tools/list-org.ts`.**

```ts
import { db } from '../../db/client.js';
import { cuSpaces, cuFolders, cuLists, cuWorkspaces } from '../../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';

export async function executeListOrgStructure(workspaceId: string) {
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  const spaces = await db.select().from(cuSpaces).where(and(eq(cuSpaces.workspaceId, workspaceId), isNull(cuSpaces.deletedAt)));
  const folders = await db.select().from(cuFolders).where(and(eq(cuFolders.workspaceId, workspaceId), isNull(cuFolders.deletedAt)));
  const lists = await db.select().from(cuLists).where(and(eq(cuLists.workspaceId, workspaceId), isNull(cuLists.deletedAt)));

  const tree = spaces.map((s) => ({
    id: s.id, name: s.name,
    folders: folders.filter((f) => f.spaceId === s.id).map((f) => ({
      id: f.id, name: f.name,
      lists: lists.filter((l) => l.folderId === f.id).map((l) => ({ id: l.id, name: l.name })),
    })),
    folderless_lists: lists.filter((l) => l.spaceId === s.id && !l.folderId).map((l) => ({ id: l.id, name: l.name })),
  }));

  return {
    data_source: 'snapshot' as const,
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    results: tree,
    truncated: false,
  };
}
```

- [ ] **Step 3: Implement `tools/get-team-members.ts`.**

```ts
import { db } from '../../db/client.js';
import { cuMembers, cuWorkspaces } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export async function executeGetTeamMembers(workspaceId: string) {
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  const rows = await db.select().from(cuMembers).where(eq(cuMembers.workspaceId, workspaceId));
  return {
    data_source: 'snapshot' as const,
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    results: rows.map((m) => ({ member_id: m.memberId, name: m.name, email: m.email, role: m.role })),
    truncated: false,
  };
}
```

- [ ] **Step 4: Implement `tools/list-custom-fields.ts`.**

```ts
import { db } from '../../db/client.js';
import { cuCustomFields, cuWorkspaces } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';

export async function executeListCustomFields(workspaceId: string, scopeId?: string) {
  const [w] = await db.select({ asOf: cuWorkspaces.lastIncrementalSyncAt }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, workspaceId)).limit(1);
  const rows = scopeId
    ? await db.select().from(cuCustomFields).where(and(eq(cuCustomFields.workspaceId, workspaceId), eq(cuCustomFields.scopeId, scopeId)))
    : await db.select().from(cuCustomFields).where(eq(cuCustomFields.workspaceId, workspaceId));
  return {
    data_source: 'snapshot' as const,
    as_of: (w?.asOf ?? new Date(0)).toISOString(),
    results: rows.map((r) => ({ id: r.customFieldId, name: r.name, type: r.type, scope_id: r.scopeId, scope_type: r.scopeType, config: r.config })),
    truncated: false,
  };
}
```

- [ ] **Step 5: Implement `tools/get-task.ts` (always-live).**

```ts
import { TurnMcpPool, callMcpTool } from '../../mcp/client.js';
import { upsertTask } from '../../sync/upsert.js';

export async function executeGetTask(workspaceId: string, taskId: string, pool: TurnMcpPool) {
  const session = await pool.get();
  const resp = await callMcpTool<{ task: Record<string, unknown> }>(session, 'get_task', { task_id: taskId });
  if (resp?.task) {
    try { await upsertTask(workspaceId, resp.task); } catch { /* non-fatal cache-back */ }
  }
  return {
    data_source: 'live' as const,
    as_of: new Date().toISOString(),
    results: resp?.task ? [normalize(resp.task)] : [],
    truncated: false,
  };
}

function normalize(t: Record<string, unknown>) {
  return {
    task_id: String(t.id),
    name: String(t.name),
    description: t.description ? String(t.description) : null,
    status: (t.status as Record<string, unknown> | undefined)?.status ?? null,
    priority: typeof t.priority === 'object' && t.priority ? Number((t.priority as Record<string, unknown>).priority ?? 0) : (t.priority ?? null),
    due_date: t.due_date ? new Date(Number(t.due_date)).toISOString().slice(0, 10) : null,
    assignees: Array.isArray(t.assignees) ? (t.assignees as Array<Record<string, unknown>>).map((a) => ({ id: String(a.id), name: a.username ? String(a.username) : undefined })) : [],
    list_id: String((t.list as Record<string, unknown> | undefined)?.id ?? ''),
    tags: Array.isArray(t.tags) ? (t.tags as Array<Record<string, unknown>>).map((tg) => String(tg.name)) : [],
    recent_comments: Array.isArray(t.comments) ? (t.comments as Array<Record<string, unknown>>).slice(0, 5).map((cm) => ({ text: String((cm.comment_text as string | undefined) ?? ''), by: cm.user ? String((cm.user as Record<string, unknown>).username ?? '') : null })) : [],
  };
}
```

- [ ] **Step 6: Implement `tools/aggregate-workload.ts`.**

```ts
import { aggregateWorkload } from '../../db/queries/aggregates.js';
import { db } from '../../db/client.js';
import { cuTasks } from '../../db/schema.js';
import { sql } from 'drizzle-orm';

export async function executeAggregateWorkload(workspaceId: string, groupBy: 'assignee' | 'list' | 'space') {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(cuTasks).where(sql`${cuTasks.workspaceId} = ${workspaceId}`);
  if (count === 0) {
    return { data_source: 'snapshot' as const, as_of: new Date(0).toISOString(), results: [], first_run: true, truncated: false };
  }
  const r = await aggregateWorkload({ workspaceId, groupBy });
  return { ...r, truncated: false };
}
```

- [ ] **Step 7: Implement `tools/aggregate-throughput.ts`.**

```ts
import { aggregateThroughput } from '../../db/queries/aggregates.js';
import { db } from '../../db/client.js';
import { cuTasks } from '../../db/schema.js';
import { sql } from 'drizzle-orm';

export async function executeAggregateThroughput(workspaceId: string, since: string, until: string) {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(cuTasks).where(sql`${cuTasks.workspaceId} = ${workspaceId}`);
  if (count === 0) {
    return { data_source: 'snapshot' as const, as_of: new Date(0).toISOString(), total_completed: 0, by_day: [], first_run: true };
  }
  return await aggregateThroughput({ workspaceId, since, until });
}
```

- [ ] **Step 8: Commit.**

```bash
git add src/server/claude/tools/
git commit -m "feat(claude): six remaining read tools (list_*, get_*, aggregate_*)"
```

---

## Task 5: Tools registry (Anthropic tool definitions)

**Files:**
- Create: `src/server/claude/tools-registry.ts`

- [ ] **Step 1: Implement.**

```ts
import type Anthropic from '@anthropic-ai/sdk';

export const ANTHROPIC_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_workspaces',
    description: 'List the ClickUp workspaces the user is connected to. In MVP, exactly one workspace per user.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_org_structure',
    description: 'Return the workspace as a tree of Spaces → Folders → Lists. Use this to scope queries.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_custom_fields',
    description: 'Return custom-field definitions. Optional scope_id (a list/folder/space id) to narrow.',
    input_schema: {
      type: 'object',
      properties: { scope_id: { type: 'string' } },
    },
  },
  {
    name: 'get_team_members',
    description: 'Return the workspace members. Use to resolve assignees and answer "who is X" — but do not surface named-person breakdowns to the user (use aggregates instead).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'query_tasks',
    description: 'Search for tasks. Supports list_id, status, assignee_id, due_before/due_after, and has_tag filters. Snapshot-backed when data is fresh; live MCP when stale.',
    input_schema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        status: { type: 'array', items: { type: 'string' } },
        assignee_id: { type: 'string' },
        due_before: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        due_after: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        has_tag: { type: 'string' },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Fetch a single task by id. Always live (no cache).',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'aggregate_workload',
    description: 'Group open tasks by assignee, list, or space. Use for "who is overloaded?" / "where is the bottleneck?" questions.',
    input_schema: {
      type: 'object',
      properties: { group_by: { type: 'string', enum: ['assignee', 'list', 'space'] } },
      required: ['group_by'],
    },
  },
  {
    name: 'aggregate_throughput',
    description: 'Count completions in a date range, grouped by day. Use for "what shipped this week?" / velocity questions.',
    input_schema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive)' },
        until: { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive)' },
      },
      required: ['since', 'until'],
    },
  },
  // Plan D will add: create_task, update_task, add_comment, delete_task
];

export const READ_ONLY_TOOL_NAMES = new Set([
  'list_workspaces', 'list_org_structure', 'list_custom_fields',
  'get_team_members', 'query_tasks', 'get_task',
  'aggregate_workload', 'aggregate_throughput',
]);
```

- [ ] **Step 2: Commit.**

```bash
git add src/server/claude/tools-registry.ts
git commit -m "feat(claude): Anthropic tool definitions for 8 read tools"
```

---

## Task 6: System prompt builder

**Files:**
- Create: `src/server/claude/system-prompt.ts`
- Test: `tests/server/claude/system-prompt.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/claude/system-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/server/claude/system-prompt.js';

describe('buildSystemPrompt', () => {
  it('includes user, workspace, and freshness', () => {
    const out = buildSystemPrompt({
      userName: 'Oz',
      userEmail: 'oz@travis.chat',
      workspaceName: 'Engineering',
      mirrorAsOf: new Date('2026-05-01T14:32:00Z'),
      taskCount: 42,
      now: new Date('2026-05-01T15:00:00Z'),
    });
    expect(out).toMatch(/Oz/);
    expect(out).toMatch(/Engineering/);
    expect(out).toMatch(/2026-05-01/);
    expect(out).toMatch(/42/);
  });

  it('includes named-person guardrail', () => {
    const out = buildSystemPrompt({
      userName: 'X', userEmail: 'x@y', workspaceName: 'W',
      mirrorAsOf: new Date(), taskCount: 0, now: new Date(),
    });
    expect(out.toLowerCase()).toContain('named-person');
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- system-prompt.test
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/claude/system-prompt.ts`.**

```ts
type Args = {
  userName: string | null;
  userEmail: string;
  workspaceName: string;
  mirrorAsOf: Date;
  taskCount: number;
  now: Date;
};

export function buildSystemPrompt(a: Args): string {
  const ageMin = Math.max(0, Math.round((a.now.getTime() - a.mirrorAsOf.getTime()) / 60000));
  return [
    `You are Tasktalk, an assistant for working with ClickUp through conversation.`,
    `Current user: ${a.userName ?? a.userEmail} (${a.userEmail})`,
    `Connected workspace: ${a.workspaceName}`,
    `Mirror snapshot as-of ${a.mirrorAsOf.toISOString()} (${ageMin} min ago); ${a.taskCount} tasks indexed.`,
    `Current time: ${a.now.toISOString()}`,
    ``,
    `## Behavior`,
    `- Be concise. These are work questions, not essays.`,
    `- When using snapshot data, if 'as_of' is more than 5 min old, mention staleness in the answer.`,
    `- For team-wide questions, use aggregate_workload or aggregate_throughput. **Do not produce named-person breakdowns** — that's a named-person query and is out of scope. If asked "what is Sarah working on?", redirect to an aggregate or self-scoped query.`,
    `- Self-scoped questions ("what should I work on?") should filter on assignee_id = the current user, resolved via get_team_members if needed.`,
    `- Prefer snapshot tools when freshness allows; only call get_task when single-task accuracy is critical.`,
    `- Tools may return results with truncated=true. If so, ask the user to narrow the scope rather than guessing.`,
    `- Use list_org_structure to discover lists/folders before scoping a query, instead of guessing names.`,
    ``,
    `## Output style`,
    `- Use short paragraphs and bullets when listing tasks.`,
    `- Cite task names verbatim, with quotes. Do not invent task ids.`,
    `- When data is from snapshot and noticeably stale, say "based on data from N minutes ago".`,
  ].join('\n');
}
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- system-prompt.test
```
Expected: 2 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/claude/system-prompt.ts tests/server/claude/system-prompt.test.ts
git commit -m "feat(claude): system prompt builder with workspace context + guardrails"
```

---

## Task 7: Tool dispatcher

**Files:**
- Create: `src/server/claude/execute-tool.ts`
- Test: `tests/server/claude/execute-tool.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/claude/execute-tool.test.ts
import { describe, it, expect } from 'vitest';
import { executeTool } from '../../../src/server/claude/execute-tool.js';
import { TurnMcpPool } from '../../../src/server/mcp/client.js';

describe('executeTool', () => {
  it('rejects unknown tool name', async () => {
    const pool = new TurnMcpPool('user-x');
    const r = await executeTool({ name: 'bogus', args: {}, workspaceId: 'ws', pool });
    expect(r.error).toMatch(/unknown tool/i);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- execute-tool.test
```
Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
import { z } from 'zod';
import type { TurnMcpPool } from '../mcp/client.js';
import { executeQueryTasks } from './tools/query-tasks.js';
import { executeListWorkspaces } from './tools/list-workspaces.js';
import { executeListOrgStructure } from './tools/list-org.js';
import { executeListCustomFields } from './tools/list-custom-fields.js';
import { executeGetTeamMembers } from './tools/get-team-members.js';
import { executeGetTask } from './tools/get-task.js';
import { executeAggregateWorkload } from './tools/aggregate-workload.js';
import { executeAggregateThroughput } from './tools/aggregate-throughput.js';
import { queryTasksArgs } from '../../shared/schemas/tools.js';

const getTaskArgs = z.object({ task_id: z.string().min(1) });
const listCustomFieldsArgs = z.object({ scope_id: z.string().optional() });
const aggregateWorkloadArgs = z.object({ group_by: z.enum(['assignee', 'list', 'space']) });
const aggregateThroughputArgs = z.object({ since: z.string(), until: z.string() });

export type ExecuteToolResult =
  | { ok: true; result: unknown; routerPath: 'snapshot' | 'live' | 'snapshot · live-fallback' | 'none'; latencyMs: number }
  | { ok: false; error: string; routerPath: 'none'; latencyMs: number };

export async function executeTool(opts: {
  name: string;
  args: Record<string, unknown>;
  workspaceId: string;
  pool: TurnMcpPool;
}): Promise<ExecuteToolResult> {
  const start = Date.now();
  try {
    let result: unknown;
    let routerPath: 'snapshot' | 'live' | 'snapshot · live-fallback' | 'none' = 'none';

    switch (opts.name) {
      case 'list_workspaces':
        result = await executeListWorkspaces(opts.workspaceId);
        routerPath = 'snapshot';
        break;
      case 'list_org_structure':
        result = await executeListOrgStructure(opts.workspaceId);
        routerPath = 'snapshot';
        break;
      case 'list_custom_fields': {
        const a = listCustomFieldsArgs.parse(opts.args);
        result = await executeListCustomFields(opts.workspaceId, a.scope_id);
        routerPath = 'snapshot';
        break;
      }
      case 'get_team_members':
        result = await executeGetTeamMembers(opts.workspaceId);
        routerPath = 'snapshot';
        break;
      case 'query_tasks': {
        const a = queryTasksArgs.parse(opts.args);
        const r = await executeQueryTasks(opts.workspaceId, a, opts.pool);
        result = r;
        routerPath = r.data_source as typeof routerPath;
        break;
      }
      case 'get_task': {
        const a = getTaskArgs.parse(opts.args);
        result = await executeGetTask(opts.workspaceId, a.task_id, opts.pool);
        routerPath = 'live';
        break;
      }
      case 'aggregate_workload': {
        const a = aggregateWorkloadArgs.parse(opts.args);
        result = await executeAggregateWorkload(opts.workspaceId, a.group_by);
        routerPath = 'snapshot';
        break;
      }
      case 'aggregate_throughput': {
        const a = aggregateThroughputArgs.parse(opts.args);
        result = await executeAggregateThroughput(opts.workspaceId, a.since, a.until);
        routerPath = 'snapshot';
        break;
      }
      default:
        return { ok: false, error: `unknown tool: ${opts.name}`, routerPath: 'none', latencyMs: Date.now() - start };
    }

    return { ok: true, result, routerPath, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err), routerPath: 'none', latencyMs: Date.now() - start };
  }
}
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- execute-tool.test
```
Expected: 1 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/claude/execute-tool.ts tests/server/claude/execute-tool.test.ts
git commit -m "feat(claude): tool dispatcher routing 8 read tools"
```

---

## Task 8: Anthropic SDK client + turn loop

**Files:**
- Create: `src/server/claude/client.ts`, `src/server/claude/turn-loop.ts`

- [ ] **Step 1: Implement `src/server/claude/client.ts`.**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';

export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const MAX_TURN_ITERATIONS = 8;
```

- [ ] **Step 2: Implement `src/server/claude/turn-loop.ts`.**

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, CLAUDE_MODEL, MAX_TURN_ITERATIONS } from './client.js';
import { ANTHROPIC_TOOLS } from './tools-registry.js';
import { executeTool, type ExecuteToolResult } from './execute-tool.js';
import { TurnMcpPool } from '../mcp/client.js';
import { db } from '../db/client.js';
import { messages, toolCalls, conversations, cuWorkspaces } from '../db/schema.js';
import { and, eq, desc, sql } from 'drizzle-orm';
import { buildSystemPrompt } from './system-prompt.js';
import { bumpLastMessageAt } from '../db/queries/conversations.js';

export type TurnEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; tool_name: string; tool_use_id: string }
  | { type: 'tool_use_complete'; tool_use_id: string; router_path: string; latency_ms: number; ok: boolean }
  | { type: 'message_complete' }
  | { type: 'error'; error: string };

export async function runTurn(opts: {
  userId: string;
  conversationId: string;
  userText: string;
  userName: string | null;
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
  emit: (event: TurnEvent) => Promise<void> | void;
}): Promise<void> {
  const pool = new TurnMcpPool(opts.userId);

  // 1. persist user message
  await db.insert(messages).values({ conversationId: opts.conversationId, role: 'user', content: { text: opts.userText } });
  await bumpLastMessageAt(opts.conversationId);

  // 2. build context
  const history = await db.select().from(messages)
    .where(eq(messages.conversationId, opts.conversationId))
    .orderBy(messages.createdAt);

  const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, opts.workspaceId)).limit(1);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, opts.workspaceId));
  const taskCountRow = await db.execute(sql`SELECT COUNT(*)::int AS c FROM cu_tasks WHERE workspace_id = ${opts.workspaceId}`);
  const taskCount = Number(((taskCountRow as unknown as Array<{ c: number }>)[0]?.c ?? 0));

  const systemPrompt = buildSystemPrompt({
    userName: opts.userName,
    userEmail: opts.userEmail,
    workspaceName: opts.workspaceName,
    mirrorAsOf: ws?.lastIncrementalSyncAt ?? new Date(0),
    taskCount,
    now: new Date(),
  });

  // 3. loop
  const apiMessages: Anthropic.MessageParam[] = history.map((m) => toApiMessage(m));

  await opts.emit({ type: 'message_start' });
  let assistantMsgId: string | null = null;
  let assistantTextBuffer = '';
  const collectedToolUses: Array<{ id: string; name: string; input: Record<string, unknown>; result: ExecuteToolResult }> = [];

  try {
    for (let iter = 0; iter < MAX_TURN_ITERATIONS; iter++) {
      const stream = anthropic.messages.stream({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] as any,
        tools: ANTHROPIC_TOOLS,
        messages: apiMessages,
      });

      const pendingToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      let textInThisIteration = '';

      stream.on('text', async (delta) => {
        textInThisIteration += delta;
        await opts.emit({ type: 'text_delta', text: delta });
      });

      const finalMessage = await stream.finalMessage();
      assistantTextBuffer += textInThisIteration;

      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          pendingToolUses.push({ id: block.id, name: block.name, input: (block.input as Record<string, unknown>) ?? {} });
        }
      }

      if (finalMessage.stop_reason === 'end_turn' || pendingToolUses.length === 0) {
        // persist assistant message + close
        const [m] = await db.insert(messages).values({ conversationId: opts.conversationId, role: 'assistant', content: { text: assistantTextBuffer, tool_uses: collectedToolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })) } }).returning();
        assistantMsgId = m!.id;
        for (const tu of collectedToolUses) {
          await db.insert(toolCalls).values({
            messageId: assistantMsgId,
            toolName: tu.name,
            args: tu.input,
            result: tu.result.ok ? (tu.result.result as Record<string, unknown> | unknown) : { error: tu.result.error },
            routerPath: tu.result.routerPath,
            latencyMs: tu.result.latencyMs,
          });
        }
        await opts.emit({ type: 'message_complete' });
        return;
      }

      // execute tools and append results to apiMessages, then continue loop
      apiMessages.push({ role: 'assistant', content: finalMessage.content });
      const toolResultsBlock: Anthropic.MessageParam = { role: 'user', content: [] };
      for (const tu of pendingToolUses) {
        await opts.emit({ type: 'tool_use_start', tool_name: tu.name, tool_use_id: tu.id });
        const result = await executeTool({ name: tu.name, args: tu.input, workspaceId: opts.workspaceId, pool });
        await opts.emit({ type: 'tool_use_complete', tool_use_id: tu.id, router_path: result.routerPath, latency_ms: result.latencyMs, ok: result.ok });
        collectedToolUses.push({ id: tu.id, name: tu.name, input: tu.input, result });
        (toolResultsBlock.content as Anthropic.ContentBlockParam[]).push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.ok ? JSON.stringify(result.result) : `error: ${result.error}`,
          is_error: !result.ok,
        });
      }
      apiMessages.push(toolResultsBlock);
    }

    // hit iteration cap
    assistantTextBuffer += '\n\n(Reached the tool-use iteration cap; let me know how to simplify.)';
    const [m] = await db.insert(messages).values({ conversationId: opts.conversationId, role: 'assistant', content: { text: assistantTextBuffer } }).returning();
    assistantMsgId = m!.id;
    await opts.emit({ type: 'message_complete' });
  } catch (err) {
    await opts.emit({ type: 'error', error: String((err as Error).message ?? err) });
  } finally {
    await pool.closeAll();
  }
}

function toApiMessage(m: { role: string; content: unknown }): Anthropic.MessageParam {
  const c = m.content as { text?: string; tool_uses?: Array<{ id: string; name: string; input: Record<string, unknown> }> } | undefined;
  if (m.role === 'user') return { role: 'user', content: c?.text ?? '' };
  if (m.role === 'assistant') {
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (c?.text) blocks.push({ type: 'text', text: c.text });
    for (const tu of c?.tool_uses ?? []) blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    return { role: 'assistant', content: blocks.length ? blocks : (c?.text ?? '') };
  }
  // 'tool' and 'system_event' messages don't go to Claude history directly; skip by collapsing to user note
  return { role: 'user', content: JSON.stringify(m.content) };
}
```

- [ ] **Step 3: Commit.**

```bash
git add src/server/claude/client.ts src/server/claude/turn-loop.ts
git commit -m "feat(claude): turn loop with streaming + tool execution + persistence"
```

---

## Task 9: Chat SSE route

**Files:**
- Create: `src/server/routes/chat.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Implement `src/server/routes/chat.ts`.**

```ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { runTurn } from '../claude/turn-loop.js';
import { db } from '../db/client.js';
import { conversations, clickupConnections, cuWorkspaces } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';

const turnBody = z.object({ text: z.string().min(1).max(8000) });

export const chatRoutes = new Hono()
  .use('*', requireAuth)
  .post('/:conversationId/turn', zValidator('json', turnBody), async (c) => {
    const u = c.get('user');
    const conversationId = c.req.param('conversationId');
    const { text } = c.req.valid('json');

    const [conv] = await db.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, u.id))).limit(1);
    if (!conv) return c.json({ error: 'not_found' }, 404);

    const [conn] = await db.select().from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt))).limit(1);
    if (!conn) return c.json({ error: 'clickup_not_connected' }, 400);

    const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, conn.workspaceId)).limit(1);
    const workspaceName = ws?.name ?? '(unknown)';

    return streamSSE(c, async (sse) => {
      await runTurn({
        userId: u.id,
        conversationId,
        userText: text,
        userName: u.name,
        userEmail: u.email,
        workspaceId: conn.workspaceId,
        workspaceName,
        emit: async (event) => {
          await sse.writeSSE({ data: JSON.stringify(event) });
        },
      });
      await sse.writeSSE({ event: 'done', data: '{}' });
    });
  });
```

- [ ] **Step 2: Mount in `src/server/index.ts`.**

```ts
import { chatRoutes } from './routes/chat.js';
// inside startWeb(): app.route('/api/chat', chatRoutes);
```

- [ ] **Step 3: Smoke test.**

With a connected user and synced workspace, send a turn:

```bash
# create a conversation:
curl -b cookies.txt -X POST http://localhost:3000/api/conversations | jq .
# (note the id)
# stream a turn:
curl -b cookies.txt -N -X POST http://localhost:3000/api/chat/<conv-id>/turn \
  -H 'content-type: application/json' \
  -d '{"text":"how many tasks do I have"}'
```
Expected: a stream of SSE events (`data: {"type":"message_start"}`, text deltas, tool_use events, `message_complete`, finally `event: done`).

- [ ] **Step 4: Commit.**

```bash
git add src/server/routes/chat.ts src/server/index.ts
git commit -m "feat(api): SSE chat turn endpoint"
```

---

## Task 10: Frontend SSE consumer hook

**Files:**
- Create: `src/web/lib/sse.ts`, `src/web/hooks/use-message-stream.ts`

- [ ] **Step 1: Implement `src/web/lib/sse.ts`.**

```ts
export type SseEvent = { event?: string; data: string };

export async function postSse(
  url: string,
  body: unknown,
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    credentials: 'include',
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const lines = block.split('\n');
      let event: string | undefined;
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      onEvent({ event, data });
    }
  }
}
```

- [ ] **Step 2: Implement `src/web/hooks/use-message-stream.ts`.**

```ts
import { useCallback, useRef, useState } from 'react';
import { postSse } from '../lib/sse.js';

export type StreamMessage = {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: Array<{ tool_use_id: string; tool_name: string; router_path?: string; latency_ms?: number; ok?: boolean }>;
  done: boolean;
};

export function useMessageStream(conversationId: string) {
  const [streaming, setStreaming] = useState<StreamMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (text: string, onComplete: () => void) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const draft: StreamMessage = { role: 'assistant', text: '', toolCalls: [], done: false };
    setStreaming(draft);

    await postSse(
      `/api/chat/${conversationId}/turn`,
      { text },
      (e) => {
        if (e.event === 'done') return;
        const ev = JSON.parse(e.data);
        if (ev.type === 'text_delta') draft.text += ev.text;
        else if (ev.type === 'tool_use_start') draft.toolCalls.push({ tool_use_id: ev.tool_use_id, tool_name: ev.tool_name });
        else if (ev.type === 'tool_use_complete') {
          const tc = draft.toolCalls.find((t) => t.tool_use_id === ev.tool_use_id);
          if (tc) { tc.router_path = ev.router_path; tc.latency_ms = ev.latency_ms; tc.ok = ev.ok; }
        } else if (ev.type === 'message_complete') {
          draft.done = true;
        } else if (ev.type === 'error') {
          draft.text += `\n\n[error: ${ev.error}]`;
          draft.done = true;
        }
        setStreaming({ ...draft });
      },
      ctrl.signal,
    );
    setStreaming(null);
    onComplete();
  }, [conversationId]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { streaming, send, cancel };
}
```

- [ ] **Step 3: Commit.**

```bash
git add src/web/lib/sse.ts src/web/hooks/use-message-stream.ts
git commit -m "feat(web): SSE consumer + useMessageStream hook"
```

---

## Task 11: Chat page + components

**Files:**
- Create: `src/web/routes/chat.tsx`, `src/web/components/chat/MessageStream.tsx`, `Composer.tsx`, `ToolCallPill.tsx`, `src/web/components/sidebar/ConversationList.tsx`, `src/web/hooks/use-conversations.ts`
- Modify: `src/web/App.tsx`, `src/web/lib/rpc.ts`

- [ ] **Step 1: Extend `src/web/lib/rpc.ts` with chat APIs.**

Add to the `api` object:

```ts
listConversations: () => request<{ conversations: Array<{ id: string; title: string; lastMessageAt: string }> }>('/api/conversations'),
createConversation: () => request<{ conversation: { id: string; title: string } }>('/api/conversations', { method: 'POST' }),
listMessages: (id: string) => request<{ messages: Array<{ id: string; role: string; content: any; createdAt: string }> }>(`/api/conversations/${id}/messages`),
deleteConversation: (id: string) => request<{ ok: true }>(`/api/conversations/${id}`, { method: 'DELETE' }),
renameConversation: (id: string, title: string) => request<{ ok: true }>(`/api/conversations/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }),
```

- [ ] **Step 2: Implement `src/web/hooks/use-conversations.ts`.**

```ts
import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/rpc.js';

export type Conv = { id: string; title: string; lastMessageAt: string };

export function useConversations() {
  const [conversations, setConversations] = useState<Conv[]>([]);
  const refresh = useCallback(async () => {
    const r = await api.listConversations();
    setConversations(r.conversations);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { conversations, refresh };
}
```

- [ ] **Step 3: Implement `src/web/components/chat/ToolCallPill.tsx`.**

```tsx
type Props = { name: string; routerPath?: string; latencyMs?: number; ok?: boolean };
export function ToolCallPill({ name, routerPath, latencyMs, ok }: Props) {
  const color = ok === false ? '#f87171' : routerPath === 'live' ? '#fbbf24' : '#34d399';
  return (
    <span
      className="group inline-flex items-center gap-1 text-[10.5px] tracking-wider uppercase rounded px-2 py-0.5 mr-1 bg-[#1a1d27] border border-[#2a2f3d]"
      style={{ color, opacity: 0.45 }}
      title={`${name} · ${routerPath ?? '…'} · ${latencyMs ?? 0}ms`}
    >
      <span className="opacity-0 group-hover:opacity-100 transition-opacity">{name}</span>
      <span className="group-hover:hidden">●</span>
    </span>
  );
}
```

- [ ] **Step 4: Implement `src/web/components/chat/MessageStream.tsx`.**

```tsx
import { ToolCallPill } from './ToolCallPill.js';
import type { StreamMessage } from '../../hooks/use-message-stream.js';

type PersistedMessage = { id: string; role: string; content: any };

type Props = {
  history: PersistedMessage[];
  streaming: StreamMessage | null;
};

export function MessageStream({ history, streaming }: Props) {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {history.map((m) => {
        if (m.role === 'user') {
          return (
            <div key={m.id} className="flex justify-end">
              <div className="bg-[#1e2230] text-[#e8eaf0] rounded-2xl rounded-br-sm px-4 py-2 max-w-[75%] text-sm whitespace-pre-wrap">{m.content?.text}</div>
            </div>
          );
        }
        if (m.role === 'assistant') {
          const tu = (m.content?.tool_uses as Array<{ id: string; name: string }>) ?? [];
          return (
            <div key={m.id} className="text-[#c9cdd9] text-sm leading-relaxed whitespace-pre-wrap max-w-[92%]">
              {tu.length > 0 && <div className="mb-1">{tu.map((t) => <ToolCallPill key={t.id} name={t.name} ok={true} />)}</div>}
              {m.content?.text}
            </div>
          );
        }
        if (m.role === 'system_event') {
          return (
            <div key={m.id} className="bg-[#60a5fa]/[.07] border-l-2 border-[#60a5fa] rounded px-3 py-1.5 text-[12px] text-[#c9cdd9]">
              <span className="text-[#60a5fa] font-bold mr-2">●</span>
              {m.content?.text ?? '(system event)'}
            </div>
          );
        }
        return null;
      })}
      {streaming && (
        <div className="text-[#c9cdd9] text-sm leading-relaxed whitespace-pre-wrap max-w-[92%]">
          {streaming.toolCalls.length > 0 && (
            <div className="mb-1">{streaming.toolCalls.map((t) => (
              <ToolCallPill key={t.tool_use_id} name={t.tool_name} routerPath={t.router_path} latencyMs={t.latency_ms} ok={t.ok} />
            ))}</div>
          )}
          {streaming.text}
          {!streaming.done && <span className="inline-block w-2 h-4 bg-[#7c6ef7] ml-1 animate-pulse" />}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement `src/web/components/chat/Composer.tsx`.**

```tsx
import { useState } from 'react';

type Props = { disabled: boolean; onSend: (text: string) => void };

export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState('');
  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim() && !disabled) { onSend(text); setText(''); }
    }
  }
  return (
    <div className="border-t border-[#2a2f3d] p-4">
      <textarea
        className="w-full bg-[#181b22] border border-[#2a2f3d] rounded-md p-3 text-sm text-[#e8eaf0] resize-none outline-none focus:border-[#7c6ef7]"
        rows={2}
        placeholder="Ask about your tasks…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKey}
        disabled={disabled}
      />
    </div>
  );
}
```

- [ ] **Step 6: Implement `src/web/components/sidebar/ConversationList.tsx`.**

```tsx
import { Link, useParams } from 'react-router-dom';
import type { Conv } from '../../hooks/use-conversations.js';

function group(convs: Conv[]) {
  const today: Conv[] = [], week: Conv[] = [], earlier: Conv[] = [];
  const now = Date.now();
  for (const c of convs) {
    const age = now - new Date(c.lastMessageAt).getTime();
    if (age < 24 * 3600_000) today.push(c);
    else if (age < 7 * 24 * 3600_000) week.push(c);
    else earlier.push(c);
  }
  return { today, week, earlier };
}

export function ConversationList({ conversations, onNew }: { conversations: Conv[]; onNew: () => void }) {
  const { id: active } = useParams();
  const groups = group(conversations);
  return (
    <aside className="w-[220px] bg-[#0f1117] border-r border-[#2a2f3d] p-3 flex flex-col h-screen overflow-y-auto">
      <button onClick={onNew} className="w-full bg-gradient-to-br from-[#7c6ef7] to-[#5b4fcf] text-white rounded-md py-2 text-sm font-semibold mb-4">+ New conversation</button>
      {Object.entries(groups).map(([label, items]) => items.length > 0 && (
        <div key={label} className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-[#5a6070] font-semibold px-2 mb-1">{label}</div>
          {items.map((c) => (
            <Link key={c.id} to={`/chat/${c.id}`}
              className={`block px-2 py-1.5 rounded-md text-[12px] mb-0.5 truncate ${active === c.id ? 'bg-[#1a1d27] text-[#e8eaf0]' : 'text-[#c9cdd9] hover:bg-[#14161e]'}`}>
              {c.title}
            </Link>
          ))}
        </div>
      ))}
    </aside>
  );
}
```

- [ ] **Step 7: Implement `src/web/routes/chat.tsx`.**

```tsx
import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/rpc.js';
import { useConversations } from '../hooks/use-conversations.js';
import { useMessageStream } from '../hooks/use-message-stream.js';
import { ConversationList } from '../components/sidebar/ConversationList.js';
import { MessageStream } from '../components/chat/MessageStream.js';
import { Composer } from '../components/chat/Composer.js';

type PersistedMessage = { id: string; role: string; content: any; createdAt: string };

export function Chat() {
  const { id } = useParams();
  const nav = useNavigate();
  const { conversations, refresh: refreshConvs } = useConversations();
  const [history, setHistory] = useState<PersistedMessage[]>([]);
  const { streaming, send } = useMessageStream(id ?? '');

  const loadHistory = useCallback(async () => {
    if (!id) return;
    const r = await api.listMessages(id);
    setHistory(r.messages);
  }, [id]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  async function newConv() {
    const r = await api.createConversation();
    await refreshConvs();
    nav(`/chat/${r.conversation.id}`);
  }

  async function onSend(text: string) {
    setHistory((h) => [...h, { id: `optimistic-${Date.now()}`, role: 'user', content: { text }, createdAt: new Date().toISOString() }]);
    await send(text, () => { void loadHistory(); void refreshConvs(); });
  }

  return (
    <div className="flex h-screen bg-[#0a0b0f] text-[#e8eaf0]">
      <ConversationList conversations={conversations} onNew={newConv} />
      <main className="flex-1 flex flex-col">
        {!id ? (
          <div className="flex-1 flex items-center justify-center text-[#9298ac]">
            <div className="text-center">
              <p className="mb-4">No conversation selected</p>
              <button onClick={newConv} className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm">Start a new one</button>
            </div>
          </div>
        ) : (
          <>
            <header className="border-b border-[#2a2f3d] px-6 py-3 text-sm text-[#9298ac]">
              {conversations.find((c) => c.id === id)?.title ?? 'Conversation'}
            </header>
            <MessageStream history={history} streaming={streaming} />
            <Composer disabled={!!streaming && !streaming.done} onSend={onSend} />
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 8: Update `src/web/App.tsx`.**

```tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './routes/login.js';
import { Settings } from './routes/settings.js';
import { Members } from './routes/members.js';
import { Chat } from './routes/chat.js';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/login/callback" element={<Login />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/members" element={<Members />} />
      <Route path="/chat" element={<Chat />} />
      <Route path="/chat/:id" element={<Chat />} />
      <Route path="/" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 9: Smoke test the end-to-end flow.**

```bash
npm run dev:server   # terminal 1
npm run dev:web      # terminal 2
```

Visit http://localhost:5173, sign in, connect ClickUp (Plan A), trigger initial sync (Plan B's CLI), then open `/chat`, click "+ New conversation," type "what tasks do I have," press Enter. Expected: streaming response with tool-call dot indicators.

- [ ] **Step 10: Commit.**

```bash
git add src/web/
git commit -m "feat(web): chat page with conversations sidebar + streaming + tool pills"
```

---

## Task 12: Useful read-only end-to-end smoke

**Files:**
- Create: `tests/integration/read-flow.smoke.md` (a manual checklist, not automated — connecting to ClickUp + Anthropic for true E2E in CI is out of scope)

- [ ] **Step 1: Write the smoke checklist.**

```md
# Read-flow smoke test (manual, after Plan C lands)

Prereqs: Plan A + B + C deployed. A connected user with synced ClickUp.

- [ ] "How many tasks do I have?" → answers, tool: query_tasks (snapshot)
- [ ] "What's overdue?" → answers, tool: query_tasks with due_before
- [ ] "Who's overloaded?" → answers, tool: aggregate_workload
- [ ] "What did the team ship last week?" → answers, tool: aggregate_throughput
- [ ] "What's the status of task <known-id>?" → answers, tool: get_task (live)
- [ ] "Show me the org structure" → answers, tool: list_org_structure
- [ ] After 6 minutes of no sync, "what tasks are open" should report a live router_path (or fallback)
- [ ] Asking "what is Sarah working on?" → assistant declines and offers an aggregate instead (named-person guardrail)
```

- [ ] **Step 2: Commit.**

```bash
git add tests/integration/read-flow.smoke.md
git commit -m "docs: read-flow manual smoke checklist"
```

---

## Self-Review

**Spec coverage (Sections 4 chat tables, 6 conversational layer, 7 read path completeness, 10 UI):**

- ✓ `conversations`, `messages`, `tool_calls` tables — Task 1 (matches spec column-for-column except `pending_writes` which is Plan D)
- ✓ `messages.role` enum includes `system_event` — Task 1 (Plan D will populate)
- ✓ `tool_calls` records `router_path` + `latency_ms` — Task 1 (consumed by tool pills)
- ✓ `aggregate_workload` snapshot SQL — Task 3
- ✓ `aggregate_throughput` snapshot SQL — Task 3
- ✓ All 6 remaining read tools — Task 4
- ✓ Anthropic tool definitions for 8 read tools — Task 5
- ✓ System prompt with workspace summary, freshness, named-person guardrail — Task 6
- ✓ Tool dispatcher with Zod validation per tool — Task 7
- ✓ Anthropic raw SDK (no Agent SDK) — Task 8
- ✓ Streaming SSE — Tasks 8, 9, 10
- ✓ Prompt caching on system prompt — Task 8 (`cache_control: ephemeral`)
- ✓ Max 8 tool-use iterations per turn — Task 8
- ✓ Per-turn MCP pool + close on finally — Task 8
- ✓ Persistent ChatGPT-style history — Tasks 1, 2, 11
- ✓ Conversation grouping Today / This week / Earlier — Task 11
- ✓ Tool-call pills hidden by default, hover to reveal — Task 11 (`opacity-0 group-hover:opacity-100`)
- ✓ Empty state — Task 11
- ✓ Conversation rename + delete API — Task 2 (UI for these is Plan D polish)

**Plan C intentionally excludes** (Plan D):
- Right sidebar with task context cards
- Theme toggle (system follow + manual)
- System event message rendering populated from webhooks (renderer landed; producer ships in Plan D)
- Suggested-prompt empty state with clickable starters
- Onboarding wizard
- Mobile drawer for left sidebar
- Per-account UI preferences persistence
- Write tools (Plan D)

**Placeholder scan:** No `TBD` or `TODO`. All code blocks complete. The `as any` cast on `system: [...]` for cache_control is required because Anthropic SDK types lag the cache_control feature for system prompts in some versions; if your installed `@anthropic-ai/sdk` exposes typed `cache_control` directly, drop the cast.

**Type consistency:**
- `messages.role` enum values match the type union used in `MessageStream.tsx`.
- `tool_calls.routerPath` enum matches `ExecuteToolResult.routerPath` and `TurnEvent.tool_use_complete.router_path`.
- `StreamMessage` shape consumed by frontend matches what `useMessageStream` builds.
- `executeQueryTasks` returns `NormalizedReadResult` (defined Plan B); other read tools return compatible shapes; the dispatcher passes them as-is to Claude.

**Real risks captured:**
1. Anthropic SDK streaming API surface (`anthropic.messages.stream` + `.on('text', ...)` + `.finalMessage()`) is what the SDK exposes; if your installed version shifts the API, adjust to the equivalent (e.g., `for await (const evt of stream)`).
2. The cache_control cast (noted above) — version-dependent.
3. The system prompt's named-person guardrail relies on Claude following instructions; the dispatcher does **not** structurally enforce it. Plan D could add a structural filter on `aggregate_workload` results that omits `group_name` when `groupBy === 'assignee'` to harden the guardrail; for MVP, the prompt is enough.

---

## What Plan C produces

After completing all 12 tasks:

1. A signed-in, ClickUp-connected user opens `/chat`, creates a conversation, types a question.
2. Claude streams an answer, calls one or more read tools transparently, and renders text with subtle tool-call dot indicators (hover to see details).
3. Conversations are persisted, browseable from the sidebar, grouped by recency.
4. All 8 read tools work: `list_workspaces`, `list_org_structure`, `list_custom_fields`, `get_team_members`, `query_tasks`, `get_task`, `aggregate_workload`, `aggregate_throughput`.
5. The Hybrid Router's `query_tasks` decision shows up in tool pills' router_path metadata.
6. Named-person queries get gracefully redirected by Claude (per system prompt).

What you can NOT yet do:
- Make any writes to ClickUp from chat.
- See the right sidebar task context.
- Switch theme.
- Get system-event notifications when ClickUp data changes mid-conversation.
- Use the onboarding wizard for first-time setup.

---

## Next steps after Plan C

- **Plan D (final)** — Write path (preview/confirm/audit), undo, system events producer, onboarding wizard, theme toggle, right sidebar, polish, deploy.
