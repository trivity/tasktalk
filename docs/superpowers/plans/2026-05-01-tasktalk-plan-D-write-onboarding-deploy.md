# Tasktalk Plan D — Write Path + Onboarding + Polish + Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop from read-only assistant to a production-ready MVP. Adds the full write path (preview/confirm/audit/undo for all four write tools), onboarding wizard with workspace-size estimation, system-event producer (webhooks → inline notices in active conversation), right-sidebar task context, theme toggle, sidebar collapse, suggested prompts, the tombstone purge cron, the Dockerfile, and Railway deployment.

**Architecture:** Writes use single-use `confirmation_token` records in `pending_writes` (5-min TTL), live MCP execute on confirm, mirror upsert and audit_log row written transactionally. System events broadcast via an in-process pub/sub keyed by `(userId, conversationId)`. Onboarding is a single-page React wizard that orchestrates connect → workspace pick → size estimate → progress.

**Tech Stack:** Same as A–C, plus a tiny in-process EventEmitter for the system-event broadcast and a Dockerfile for Railway.

**Spec reference:** `docs/superpowers/specs/2026-05-01-tasktalk-design.md` Sections 4 (`pending_writes`, `audit_log`), 6 (write tools), 8 (Write path), 9 (system events into conversations + tombstone purge), 10 (onboarding, theme, sidebar), 11 (deployment).

**Plan A + B + C prerequisites:** authenticated app, ClickUp OAuth + sync, conversational read path with all 8 read tools.

---

## File Structure (Plan D scope)

**Created:**
- `src/server/db/schema.ts` (extended) — `pending_writes`, `audit_log`
- `src/server/claude/tools/create-task.ts`, `update-task.ts`, `add-comment.ts`, `delete-task.ts`
- `src/server/claude/preview.ts` — preview struct builder (per tool)
- `src/server/claude/write-executor.ts` — confirm-token validation + MCP write + audit + mirror upsert
- `src/server/routes/confirm-write.ts` — POST `/api/confirm-write`
- `src/server/routes/undo.ts` — POST `/api/conversations/:id/undo`
- `src/server/sync/system-events.ts` — webhook → conversation broadcast + relevance filter
- `src/server/sync/tombstone-purge.ts` — cron handler for >7-day tombstoned connections
- `src/server/sync/workspace-estimate.ts` — sample-based row count for onboarding
- `src/web/routes/onboarding.tsx` — wizard
- `src/web/components/chat/ConfirmCard.tsx`, `BulkConfirmCard.tsx`, `UndoChip.tsx`, `SystemEventNote.tsx`
- `src/web/components/sidebar/TaskContextPanel.tsx`
- `src/web/components/ui/ThemeToggle.tsx`
- `src/web/hooks/use-theme.ts`, `use-task-context.ts`
- `Dockerfile`, `railway.toml`, `docker-compose.yml` (local dev)
- `tests/server/claude/preview.test.ts`, `tests/server/sync/system-events.test.ts`

**Modified:**
- `src/server/claude/turn-loop.ts` — pause-and-resume on write tool calls; emit `needs_confirmation`
- `src/server/claude/tools-registry.ts` — add 4 write tools
- `src/server/claude/execute-tool.ts` — route write tools through write-executor
- `src/web/hooks/use-message-stream.ts` — handle `needs_confirmation`, `system_event` events
- `src/web/components/chat/MessageStream.tsx` — render confirm cards + undo chip + system events
- `src/web/routes/chat.tsx` — open right sidebar; toggle controls; suggested prompts
- `src/web/index.html` + `src/web/styles.css` — light/dark CSS variables
- `src/server/sync/boss.ts` + `index.ts` — register tombstone-purge cron

---

## Task 1: Schema for pending_writes + audit_log

**Files:**
- Modify: `src/server/db/schema.ts`
- Generated: `drizzle/0003_*.sql`

- [ ] **Step 1: Append to `src/server/db/schema.ts`.**

```ts
export const pendingWrites = pgTable(
  'pending_writes',
  {
    confirmationToken: uuid('confirmation_token').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    toolUseId: text('tool_use_id').notNull(),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    preview: jsonb('preview').$type<unknown>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index('pending_writes_user_idx').on(t.userId, t.expiresAt) }),
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    action: text('action', { enum: ['create_task', 'update_task', 'add_comment', 'delete_task', 'undo'] }).notNull(),
    targetType: text('target_type', { enum: ['task', 'comment'] }).notNull(),
    targetId: text('target_id').notNull(),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    status: text('status', { enum: ['pending', 'ok', 'failed'] }).notNull().default('pending'),
    errorMessage: text('error_message'),
    undone: boolean('undone').notNull().default(false),
    undoTargetId: uuid('undo_target_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('audit_log_user_idx').on(t.userId, t.createdAt),
    convIdx: index('audit_log_conv_idx').on(t.conversationId, t.createdAt),
  }),
);
```

- [ ] **Step 2: Generate + apply migration.**

```bash
npm run db:generate
npm run db:push
```
Verify:
```bash
docker exec -it tasktalk-pg psql -U postgres -d tasktalk -c "\dt pending_writes audit_log"
```
Expected: 2 tables.

- [ ] **Step 3: Commit.**

```bash
git add src/server/db/schema.ts drizzle/
git commit -m "feat(db): pending_writes + audit_log schema"
```

---

## Task 2: Preview struct builder

**Files:**
- Create: `src/server/claude/preview.ts`
- Test: `tests/server/claude/preview.test.ts`

The preview is what the user sees in the inline confirm card. For `update_task`, it shows per-field before/after. For `create_task`, just the after. For `delete_task`, the before only with a destructive-action warning. For `add_comment`, the comment text.

- [ ] **Step 1: Write the failing test.**

```ts
// tests/server/claude/preview.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../../src/server/db/client.js';
import { cuWorkspaces, cuLists, cuTasks } from '../../../src/server/db/schema.js';
import { buildPreview } from '../../../src/server/claude/preview.js';

const WS = `pv-${Date.now()}`;
const LIST = `pv-l-${Date.now()}`;

beforeAll(async () => {
  await db.insert(cuWorkspaces).values({ workspaceId: WS, name: 'pv', lastIncrementalSyncAt: new Date() }).onConflictDoNothing();
  await db.insert(cuLists).values({ id: LIST, workspaceId: WS, name: 'l' }).onConflictDoNothing();
  await db.insert(cuTasks).values({
    taskId: 'pv-t1', workspaceId: WS, listId: LIST, name: 'Old name', status: 'open',
    assignees: [], tags: [], updatedAtClickup: new Date(), priority: 2,
  }).onConflictDoNothing();
});

describe('buildPreview', () => {
  it('builds an update_task diff', async () => {
    const p = await buildPreview({
      workspaceId: WS, toolName: 'update_task',
      args: { task_id: 'pv-t1', patch: { name: 'New name', status: 'closed' } },
    });
    expect(p.kind).toBe('update_task');
    expect(p.target.name).toBe('Old name');
    const fieldByKey = Object.fromEntries(p.fields.map((f) => [f.key, f]));
    expect(fieldByKey.name).toEqual({ key: 'name', before: 'Old name', after: 'New name' });
    expect(fieldByKey.status).toEqual({ key: 'status', before: 'open', after: 'closed' });
  });

  it('builds a create_task preview', async () => {
    const p = await buildPreview({
      workspaceId: WS, toolName: 'create_task',
      args: { list_id: LIST, name: 'Brand new', due_date: '2026-05-08' },
    });
    expect(p.kind).toBe('create_task');
    expect(p.fields.find((f) => f.key === 'name')?.after).toBe('Brand new');
  });

  it('builds a delete_task preview with destructive flag', async () => {
    const p = await buildPreview({
      workspaceId: WS, toolName: 'delete_task',
      args: { task_id: 'pv-t1' },
    });
    expect(p.kind).toBe('delete_task');
    expect(p.destructive).toBe(true);
    expect(p.target.name).toBe('Old name');
  });

  it('builds an add_comment preview', async () => {
    const p = await buildPreview({
      workspaceId: WS, toolName: 'add_comment',
      args: { task_id: 'pv-t1', text: 'Looks good to me.' },
    });
    expect(p.kind).toBe('add_comment');
    expect(p.fields.find((f) => f.key === 'text')?.after).toBe('Looks good to me.');
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
npm test -- preview.test
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/claude/preview.ts`.**

```ts
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
```

- [ ] **Step 4: Run, verify pass.**

```bash
npm test -- preview.test
```
Expected: 4 passed.

- [ ] **Step 5: Commit.**

```bash
git add src/server/claude/preview.ts tests/server/claude/preview.test.ts
git commit -m "feat(claude): preview struct builder for 4 write tools"
```

---

## Task 3: Write tool handlers (live MCP + audit + mirror)

**Files:**
- Create: `src/server/claude/tools/create-task.ts`, `update-task.ts`, `add-comment.ts`, `delete-task.ts`, `src/server/claude/write-executor.ts`

These are called *after* user confirmation, by the confirm-write route. The result is appended to the Claude turn loop as a tool_result.

- [ ] **Step 1: Implement `src/server/claude/write-executor.ts`.**

```ts
import { db } from '../db/client.js';
import { auditLog, cuTasks } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { TurnMcpPool, callMcpTool, openMcpSession } from '../mcp/client.js';
import { upsertTask, softDeleteTask } from '../sync/upsert.js';

export type WriteResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  auditId?: string;
};

export async function executeWrite(opts: {
  userId: string;
  conversationId: string;
  workspaceId: string;
  messageId: string | null; // assistant message that proposed the write (set when known)
  toolName: 'create_task' | 'update_task' | 'add_comment' | 'delete_task';
  args: Record<string, unknown>;
}): Promise<WriteResult> {
  // 1. snapshot 'before' from mirror
  const before = await readBefore(opts);

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
  try {
    let mcpResult: Record<string, unknown> | null = null;
    if (opts.toolName === 'create_task') {
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'create_task', opts.args);
    } else if (opts.toolName === 'update_task') {
      const { task_id, patch } = opts.args as { task_id: string; patch: Record<string, unknown> };
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'update_task', { task_id, ...patch });
    } else if (opts.toolName === 'add_comment') {
      const { task_id, text } = opts.args as { task_id: string; text: string };
      mcpResult = await callMcpTool<Record<string, unknown>>(session, 'add_comment', { task_id, comment_text: text });
    } else if (opts.toolName === 'delete_task') {
      const { task_id } = opts.args as { task_id: string };
      await callMcpTool(session, 'delete_task', { task_id });
      mcpResult = null;
    }

    // 4. mirror upsert / soft delete
    if (opts.toolName === 'delete_task') {
      const { task_id } = opts.args as { task_id: string };
      await softDeleteTask(task_id);
    } else if (opts.toolName === 'create_task' || opts.toolName === 'update_task') {
      // re-fetch via get_task for canonical 'after'
      const taskId = opts.toolName === 'create_task'
        ? (mcpResult?.id ? String(mcpResult.id) : '')
        : String((opts.args as { task_id: string }).task_id);
      if (taskId) {
        try {
          const fetched = await callMcpTool<{ task: Record<string, unknown> }>(session, 'get_task', { task_id: taskId });
          if (fetched?.task) await upsertTask(opts.workspaceId, fetched.task);
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
```

- [ ] **Step 2: Commit.**

```bash
git add src/server/claude/write-executor.ts
git commit -m "feat(claude): write executor (MCP call + audit + mirror upsert)"
```

---

## Task 4: Add write tool definitions + dispatcher entries

**Files:**
- Modify: `src/server/claude/tools-registry.ts`, `src/server/claude/execute-tool.ts`, `src/server/claude/turn-loop.ts`

For Plan D, write tools enter the Claude tool inventory but the dispatcher returns a special `needs_confirmation` outcome instead of executing immediately. The turn loop pauses, emits SSE, persists a `pending_writes` row, and waits for the confirm-write route to resume.

- [ ] **Step 1: Extend `src/server/claude/tools-registry.ts`.**

Append to `ANTHROPIC_TOOLS`:

```ts
{
  name: 'create_task',
  description: 'Create a new task in a list. Always requires user confirmation before executing.',
  input_schema: {
    type: 'object',
    properties: {
      list_id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      due_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      assignees: { type: 'array', items: { type: 'string' } },
      priority: { type: 'integer', enum: [1, 2, 3, 4] },
    },
    required: ['list_id', 'name'],
  },
},
{
  name: 'update_task',
  description: 'Update fields on an existing task. Always requires user confirmation.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      patch: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string' },
          due_date: { type: 'string' },
          assignees: { type: 'array', items: { type: 'string' } },
          priority: { type: 'integer' },
        },
      },
    },
    required: ['task_id', 'patch'],
  },
},
{
  name: 'add_comment',
  description: 'Post a comment on a task. Always requires user confirmation.',
  input_schema: {
    type: 'object',
    properties: { task_id: { type: 'string' }, text: { type: 'string' } },
    required: ['task_id', 'text'],
  },
},
{
  name: 'delete_task',
  description: 'Delete a task. Destructive — user must type DELETE to confirm. Use only on explicit user request.',
  input_schema: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id'],
  },
},
```

Also add:

```ts
export const WRITE_TOOL_NAMES = new Set(['create_task', 'update_task', 'add_comment', 'delete_task']);
```

- [ ] **Step 2: Update `src/server/claude/turn-loop.ts` to pause-and-resume on writes.**

In the iteration loop, before executing tools, partition `pendingToolUses` into reads vs writes. For write tools:

```ts
import { WRITE_TOOL_NAMES } from './tools-registry.js';
import { buildPreview } from './preview.js';
import { db } from '../db/client.js';
import { pendingWrites } from '../db/schema.js';
import { randomUUID } from 'node:crypto';

// inside the iteration loop, replace the simple execute loop with:

const reads = pendingToolUses.filter((tu) => !WRITE_TOOL_NAMES.has(tu.name));
const writes = pendingToolUses.filter((tu) => WRITE_TOOL_NAMES.has(tu.name));

// 1) execute reads as before (they don't need confirmation)
for (const tu of reads) {
  await opts.emit({ type: 'tool_use_start', tool_name: tu.name, tool_use_id: tu.id });
  const result = await executeTool({ name: tu.name, args: tu.input, workspaceId: opts.workspaceId, pool });
  await opts.emit({ type: 'tool_use_complete', tool_use_id: tu.id, router_path: result.routerPath, latency_ms: result.latencyMs, ok: result.ok });
  collectedToolUses.push({ id: tu.id, name: tu.name, input: tu.input, result });
  (toolResultsBlock.content as Anthropic.ContentBlockParam[]).push({
    type: 'tool_result', tool_use_id: tu.id,
    content: result.ok ? JSON.stringify(result.result) : `error: ${result.error}`,
    is_error: !result.ok,
  });
}

// 2) for each write tool, build preview + emit needs_confirmation + persist pending_writes
for (const tu of writes) {
  let preview;
  try {
    preview = await buildPreview({ workspaceId: opts.workspaceId, toolName: tu.name, args: tu.input });
  } catch (e) {
    const errMsg = String((e as Error).message ?? e);
    (toolResultsBlock.content as Anthropic.ContentBlockParam[]).push({
      type: 'tool_result', tool_use_id: tu.id,
      content: `preview_error: ${errMsg}`, is_error: true,
    });
    continue;
  }
  const token = randomUUID();
  await db.insert(pendingWrites).values({
    confirmationToken: token,
    userId: opts.userId,
    conversationId: opts.conversationId,
    toolUseId: tu.id,
    toolName: tu.name,
    args: tu.input,
    preview,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  await opts.emit({ type: 'needs_confirmation', tool_use_id: tu.id, tool_name: tu.name, confirmation_token: token, preview } as TurnEvent);
}

// If any writes were proposed, we end the turn here. The confirm-write route will persist the
// outcomes and the user's next message (or an explicit "continue" trigger) starts a new turn
// that already has the writes' tool_results available via the assistant message.
if (writes.length > 0) {
  // persist the assistant message with tool_uses (no text completion yet)
  const [m] = await db.insert(messages).values({
    conversationId: opts.conversationId,
    role: 'assistant',
    content: { text: assistantTextBuffer, tool_uses: collectedToolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })).concat(writes.map((w) => ({ id: w.id, name: w.name, input: w.input }))) },
  }).returning();
  for (const tu of collectedToolUses) {
    await db.insert(toolCalls).values({
      messageId: m!.id, toolName: tu.name, args: tu.input,
      result: tu.result.ok ? (tu.result.result as unknown) : { error: tu.result.error },
      routerPath: tu.result.routerPath, latencyMs: tu.result.latencyMs,
    });
  }
  await opts.emit({ type: 'message_complete' });
  return;
}

// otherwise, append toolResultsBlock and continue loop as in Plan C
apiMessages.push({ role: 'assistant', content: finalMessage.content });
apiMessages.push(toolResultsBlock);
```

Add the new event type to `TurnEvent`:

```ts
export type TurnEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; tool_name: string; tool_use_id: string }
  | { type: 'tool_use_complete'; tool_use_id: string; router_path: string; latency_ms: number; ok: boolean }
  | { type: 'needs_confirmation'; tool_use_id: string; tool_name: string; confirmation_token: string; preview: unknown }
  | { type: 'message_complete' }
  | { type: 'error'; error: string };
```

- [ ] **Step 3: Commit.**

```bash
git add src/server/claude/tools-registry.ts src/server/claude/turn-loop.ts
git commit -m "feat(claude): write-tool pause-and-resume in turn loop with needs_confirmation"
```

---

## Task 5: Confirm-write route (resumes the turn)

**Files:**
- Create: `src/server/routes/confirm-write.ts`
- Modify: `src/server/index.ts`

When the user clicks Confirm, the frontend POSTs the token. Server validates → executes → emits a "continue" SSE on a follow-up channel by **starting a fresh continuation turn** that supplies the tool_result.

For MVP simplicity: instead of resuming the old SSE stream (which is complex), we start a *new* SSE stream that includes the prior assistant message in history (which it already does — it's persisted) and a synthetic system note telling Claude the result. This is functionally equivalent and far simpler.

- [ ] **Step 1: Implement.**

```ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { pendingWrites, conversations, clickupConnections, cuWorkspaces, messages, toolCalls } from '../db/schema.js';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { executeWrite } from '../claude/write-executor.js';
import { runTurn } from '../claude/turn-loop.js';

const body = z.object({ confirmation_token: z.string().uuid(), confirm: z.boolean() });

export const confirmWriteRoutes = new Hono()
  .use('*', requireAuth)
  .post('/', zValidator('json', body), async (c) => {
    const u = c.get('user');
    const { confirmation_token, confirm } = c.req.valid('json');

    const [pending] = await db.select().from(pendingWrites)
      .where(and(eq(pendingWrites.confirmationToken, confirmation_token), eq(pendingWrites.userId, u.id), isNull(pendingWrites.consumedAt), gt(pendingWrites.expiresAt, new Date())))
      .limit(1);
    if (!pending) return c.json({ error: 'token_invalid_or_expired' }, 404);

    // mark consumed FIRST so a double-click can't re-execute
    await db.update(pendingWrites).set({ consumedAt: new Date() }).where(eq(pendingWrites.confirmationToken, confirmation_token));

    if (!confirm) {
      // user denied — append a synthetic tool_result-as-system message; next user turn will continue
      await db.insert(messages).values({
        conversationId: pending.conversationId,
        role: 'tool',
        content: { tool_use_id: pending.toolUseId, status: 'denied' },
      });
      return c.json({ ok: true, status: 'denied' });
    }

    const [conn] = await db.select().from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt))).limit(1);
    if (!conn) return c.json({ error: 'clickup_not_connected' }, 400);

    const result = await executeWrite({
      userId: u.id,
      conversationId: pending.conversationId,
      workspaceId: conn.workspaceId,
      messageId: null,
      toolName: pending.toolName as any,
      args: pending.args,
    });

    // persist tool result message so future turns include it as part of history
    await db.insert(messages).values({
      conversationId: pending.conversationId,
      role: 'tool',
      content: {
        tool_use_id: pending.toolUseId,
        ok: result.ok,
        result: result.ok ? result.result : null,
        error: result.error ?? null,
        audit_id: result.auditId,
      },
    });

    // continue the turn: stream Claude's reaction to the result
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, pending.conversationId)).limit(1);
    const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, conn.workspaceId)).limit(1);

    return streamSSE(c, async (sse) => {
      await runTurn({
        userId: u.id,
        conversationId: pending.conversationId,
        userText: result.ok
          ? `[system: write '${pending.toolName}' confirmed and succeeded]`
          : `[system: write '${pending.toolName}' confirmed but failed: ${result.error}]`,
        userName: u.name,
        userEmail: u.email,
        workspaceId: conn.workspaceId,
        workspaceName: ws?.name ?? '(unknown)',
        emit: async (event) => { await sse.writeSSE({ data: JSON.stringify(event) }); },
      });
      await sse.writeSSE({ event: 'done', data: '{}' });
    });
  });
```

> **Implementation note:** the synthetic `[system: …]` user message keeps the design simple. The system prompt should tell Claude these `[system: …]` messages aren't from the human; an alternative is to surface them as `role: 'tool'` and have the turn loop translate them — slightly cleaner but more code. Keep the simple path for MVP.

- [ ] **Step 2: Mount in `src/server/index.ts`.**

```ts
import { confirmWriteRoutes } from './routes/confirm-write.js';
// inside startWeb(): app.route('/api/confirm-write', confirmWriteRoutes);
```

- [ ] **Step 3: Update system prompt to mention these synthetic notes.**

Append to the prompt in `src/server/claude/system-prompt.ts`:

```
- Messages prefixed with "[system:" are not from the human user — they are notifications about background events (write confirmations, system events). Treat them as factual context.
```

- [ ] **Step 4: Commit.**

```bash
git add src/server/routes/confirm-write.ts src/server/index.ts src/server/claude/system-prompt.ts
git commit -m "feat(api): confirm-write route resumes turn with synthetic system note"
```

---

## Task 6: Undo route + handler

**Files:**
- Create: `src/server/routes/undo.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Implement.**

```ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { auditLog, conversations, clickupConnections, cuWorkspaces } from '../db/schema.js';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { executeWrite } from '../claude/write-executor.js';
import { runTurn } from '../claude/turn-loop.js';

export const undoRoutes = new Hono()
  .use('*', requireAuth)
  .post('/:conversationId', async (c) => {
    const u = c.get('user');
    const conversationId = c.req.param('conversationId');

    const [conv] = await db.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, u.id))).limit(1);
    if (!conv) return c.json({ error: 'not_found' }, 404);

    const [last] = await db.select().from(auditLog)
      .where(and(eq(auditLog.conversationId, conversationId), eq(auditLog.undone, false), eq(auditLog.status, 'ok')))
      .orderBy(desc(auditLog.createdAt)).limit(1);
    if (!last) return c.json({ error: 'nothing_to_undo' }, 400);

    const [conn] = await db.select().from(clickupConnections)
      .where(and(eq(clickupConnections.userId, u.id), isNull(clickupConnections.tombstonedAt))).limit(1);
    if (!conn) return c.json({ error: 'clickup_not_connected' }, 400);

    const inverse = inverseAction(last.action, last.before, last.after, last.targetId);
    if (!inverse) return c.json({ error: 'cannot_undo' }, 400);

    const result = await executeWrite({
      userId: u.id,
      conversationId,
      workspaceId: conn.workspaceId,
      messageId: null,
      toolName: inverse.toolName,
      args: inverse.args,
    });

    if (result.ok && result.auditId) {
      await db.update(auditLog).set({ undone: true, undoTargetId: result.auditId }).where(eq(auditLog.id, last.id));
      await db.update(auditLog).set({ action: 'undo' }).where(eq(auditLog.id, result.auditId));
    }

    const [ws] = await db.select().from(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, conn.workspaceId)).limit(1);
    return streamSSE(c, async (sse) => {
      await runTurn({
        userId: u.id, conversationId,
        userText: result.ok ? `[system: undo of '${last.action}' on ${last.targetType} ${last.targetId} succeeded]` : `[system: undo failed: ${result.error}]`,
        userName: u.name, userEmail: u.email,
        workspaceId: conn.workspaceId, workspaceName: ws?.name ?? '(unknown)',
        emit: async (e) => { await sse.writeSSE({ data: JSON.stringify(e) }); },
      });
      await sse.writeSSE({ event: 'done', data: '{}' });
    });
  });

function inverseAction(action: string, before: unknown, after: unknown, targetId: string): { toolName: 'create_task' | 'update_task' | 'add_comment' | 'delete_task'; args: Record<string, unknown> } | null {
  if (action === 'create_task') {
    const taskId = (after as Record<string, unknown> | null)?.id ? String((after as Record<string, unknown>).id) : targetId;
    return { toolName: 'delete_task', args: { task_id: taskId } };
  }
  if (action === 'update_task') {
    const b = before as Record<string, unknown> | null; if (!b) return null;
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'status', 'priority', 'dueDate', 'startDate']) {
      if (k in b) patch[mapMirrorKey(k)] = b[k];
    }
    return { toolName: 'update_task', args: { task_id: targetId, patch } };
  }
  if (action === 'add_comment') {
    // ClickUp MCP may or may not expose delete_comment; if it doesn't, return null and the
    // route returns cannot_undo. Otherwise:
    const commentId = (after as Record<string, unknown> | null)?.id;
    if (!commentId) return null;
    // not modeled as a write tool; return null and surface "manual delete needed".
    return null;
  }
  if (action === 'delete_task') {
    const b = before as Record<string, unknown> | null; if (!b) return null;
    return {
      toolName: 'create_task',
      args: {
        list_id: String((b.list as Record<string, unknown> | undefined)?.id ?? b.listId),
        name: String(b.name),
        description: b.description ?? '',
        priority: b.priority ?? null,
        due_date: b.dueDate ?? null,
      },
    };
  }
  return null;
}

function mapMirrorKey(k: string): string {
  if (k === 'dueDate') return 'due_date';
  if (k === 'startDate') return 'start_date';
  return k;
}
```

- [ ] **Step 2: Mount in `src/server/index.ts`.**

```ts
import { undoRoutes } from './routes/undo.js';
// inside startWeb(): app.route('/api/undo', undoRoutes);
```

- [ ] **Step 3: Commit.**

```bash
git add src/server/routes/undo.ts src/server/index.ts
git commit -m "feat(api): single-step undo route (executes inverse via write executor)"
```

---

## Task 7: System events — webhook → conversation broadcast

**Files:**
- Create: `src/server/sync/system-events.ts`
- Modify: `src/server/sync/sync-task.ts` (emit broadcast after upsert), `src/server/routes/chat.ts` (subscribe stream)

The producer is in the worker process (where `sync-task` runs); the consumer is in the web process (the SSE chat stream). They need to communicate. Easiest cross-process channel: **Postgres LISTEN/NOTIFY**, which pg-boss already uses internally.

- [ ] **Step 1: Implement `src/server/sync/system-events.ts`.**

```ts
import postgres from 'postgres';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { messages, conversations, cuTasks } from '../db/schema.js';
import { and, eq, gt, sql, desc } from 'drizzle-orm';

export type SystemEventPayload = {
  workspaceId: string;
  taskId: string;
  changeType: 'updated' | 'created' | 'deleted' | 'commented';
  taskName: string;
};

const NOTIFY_CHANNEL = 'tasktalk_system_events';

const notifier = postgres(env.DATABASE_URL, { max: 1 });

export async function broadcastSystemEvent(p: SystemEventPayload): Promise<void> {
  await notifier.notify(NOTIFY_CHANNEL, JSON.stringify(p));
}

const subscribers = new Map<string, Set<(p: SystemEventPayload) => void>>();
let listenStarted = false;

export async function subscribeForUserConversation(userId: string, conversationId: string, cb: (p: SystemEventPayload) => void): Promise<() => void> {
  await ensureListening();
  const key = `${userId}::${conversationId}`;
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key)!.add(cb);
  return () => {
    subscribers.get(key)?.delete(cb);
    if (subscribers.get(key)?.size === 0) subscribers.delete(key);
  };
}

async function ensureListening(): Promise<void> {
  if (listenStarted) return;
  listenStarted = true;
  const listener = postgres(env.DATABASE_URL, { max: 1 });
  await listener.listen(NOTIFY_CHANNEL, async (payload) => {
    try {
      const p = JSON.parse(payload) as SystemEventPayload;
      await fanout(p);
    } catch { /* swallow */ }
  });
}

async function fanout(p: SystemEventPayload): Promise<void> {
  // For each active subscriber, decide whether the event is relevant to that conversation.
  for (const [key, cbs] of subscribers) {
    const [userId, conversationId] = key.split('::');
    const relevant = await isRelevant({ userId: userId!, conversationId: conversationId!, taskId: p.taskId, workspaceId: p.workspaceId });
    if (!relevant) continue;
    // persist the system_event message
    await db.insert(messages).values({
      conversationId: conversationId!,
      role: 'system_event',
      content: { text: `Task "${p.taskName}" was ${p.changeType}`, taskId: p.taskId, changeType: p.changeType, taskName: p.taskName },
    });
    for (const cb of cbs) cb(p);
  }
}

async function isRelevant(opts: { userId: string; conversationId: string; taskId: string; workspaceId: string }): Promise<boolean> {
  // (a) mentioned in last 20 messages of the conversation
  const recent = await db.select({ content: messages.content }).from(messages)
    .where(eq(messages.conversationId, opts.conversationId))
    .orderBy(desc(messages.createdAt)).limit(20);
  for (const m of recent) {
    const c = m.content as Record<string, unknown> | null;
    const blob = JSON.stringify(c ?? '');
    if (blob.includes(opts.taskId)) return true;
  }

  // (b) assigned to current user (we don't yet know mapping app-user → ClickUp member id;
  //     in MVP we skip this branch and rely on (a) and (c). Phase 2 introduces a mapping.)

  // (c) recently queried list contains this task — we don't model "recently queried" in MVP;
  //     skip and rely on (a).
  return false;
}
```

- [ ] **Step 2: Hook the producer in `src/server/sync/sync-task.ts`.**

After the `await upsertTask(...)` (or `softDeleteTask`) call, add:

```ts
import { broadcastSystemEvent } from './system-events.js';
// after upsert/delete:
await broadcastSystemEvent({
  workspaceId,
  taskId,
  changeType: resp?.task ? 'updated' : 'deleted',
  taskName: resp?.task ? String((resp.task as Record<string, unknown>).name ?? taskId) : taskId,
});
```

- [ ] **Step 3: Hook the consumer in `src/server/routes/chat.ts`.**

In the SSE stream handler, after `runTurn` returns, also subscribe to system events for the lifetime of the connection — but for MVP simplicity, the system-event message is **persisted to the messages table** in `fanout`, and the frontend re-fetches history after each message_complete. That avoids cross-stream coordination.

Add a separate route: `GET /api/conversations/:id/events` — long-lived SSE that streams system events for that conversation.

```ts
// add to src/server/routes/conversations.ts
import { streamSSE } from 'hono/streaming';
import { subscribeForUserConversation } from '../sync/system-events.js';

// inside conversationRoutes:
.get('/:id/events', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  return streamSSE(c, async (sse) => {
    const unsub = await subscribeForUserConversation(u.id, id, async (p) => {
      await sse.writeSSE({ event: 'system_event', data: JSON.stringify(p) });
    });
    sse.onAbort(() => unsub());
    // keep alive
    await new Promise<void>((resolve) => sse.onAbort(() => resolve()));
  });
});
```

- [ ] **Step 4: Commit.**

```bash
git add src/server/sync/system-events.ts src/server/sync/sync-task.ts src/server/routes/conversations.ts
git commit -m "feat(sync): system-event producer + LISTEN/NOTIFY fanout + SSE consumer route"
```

---

## Task 8: Tombstone purge cron

**Files:**
- Create: `src/server/sync/tombstone-purge.ts`
- Modify: `src/server/sync/boss.ts`, `src/server/index.ts`

- [ ] **Step 1: Implement `src/server/sync/tombstone-purge.ts`.**

```ts
import { db } from '../db/client.js';
import { clickupConnections, cuWorkspaces, cuSpaces, cuFolders, cuLists, cuTasks, cuMembers, cuCustomFields } from '../db/schema.js';
import { and, eq, lt, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { removeWorkspaceWebhook } from './webhooks.js';

export async function runTombstonePurge(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const expired = await db.select().from(clickupConnections)
    .where(and(isNotNull(clickupConnections.tombstonedAt), lt(clickupConnections.tombstonedAt, cutoff)));

  for (const c of expired) {
    try { await removeWorkspaceWebhook(c.userId, c.workspaceId); } catch { /* tokens may already be invalid */ }
    // hard-delete connection
    await db.delete(clickupConnections).where(eq(clickupConnections.id, c.id));

    // if no other active connection points to this workspace, purge mirror
    const [otherActive] = await db.select().from(clickupConnections)
      .where(and(eq(clickupConnections.workspaceId, c.workspaceId), sql`${clickupConnections.tombstonedAt} IS NULL`)).limit(1);
    if (!otherActive) {
      await db.delete(cuTaskCustomFieldValuesByWorkspace(c.workspaceId));
      await db.delete(cuTasks).where(eq(cuTasks.workspaceId, c.workspaceId));
      await db.delete(cuCustomFields).where(eq(cuCustomFields.workspaceId, c.workspaceId));
      await db.delete(cuLists).where(eq(cuLists.workspaceId, c.workspaceId));
      await db.delete(cuFolders).where(eq(cuFolders.workspaceId, c.workspaceId));
      await db.delete(cuSpaces).where(eq(cuSpaces.workspaceId, c.workspaceId));
      await db.delete(cuMembers).where(eq(cuMembers.workspaceId, c.workspaceId));
      await db.delete(cuWorkspaces).where(eq(cuWorkspaces.workspaceId, c.workspaceId));
    }
  }
}

function cuTaskCustomFieldValuesByWorkspace(workspaceId: string) {
  // helper for the rare cascading delete; relies on FK from cu_task_custom_field_values to cu_tasks
  // which already cascades on delete. This function exists for clarity of intent.
  return cuTasks.workspaceId.name === workspaceId ? cuTasks : cuTasks; // no-op; actual delete via cuTasks below
}
```

> Cleanup of `cu_task_custom_field_values` happens automatically via the ON DELETE CASCADE on the foreign key from `task_id → cu_tasks.task_id`. The helper function is kept for readability.

- [ ] **Step 2: Register cron in `src/server/sync/boss.ts`.**

Add:

```ts
export const QUEUE_TOMBSTONE_PURGE = 'tombstone-purge';
```

In `src/server/index.ts` worker block:

```ts
import { runTombstonePurge } from './sync/tombstone-purge.js';
import { QUEUE_TOMBSTONE_PURGE } from './sync/boss.js';

await boss.work(QUEUE_TOMBSTONE_PURGE, { batchSize: 1 }, async () => { await runTombstonePurge(); });
await boss.schedule(QUEUE_TOMBSTONE_PURGE, '0 5 * * *', {}, { tz: 'UTC' });
```

- [ ] **Step 3: Commit.**

```bash
git add src/server/sync/tombstone-purge.ts src/server/sync/boss.ts src/server/index.ts
git commit -m "feat(sync): daily tombstone purge cron (>7 days)"
```

---

## Task 9: Frontend — confirm card + bulk confirm + undo chip

**Files:**
- Create: `src/web/components/chat/ConfirmCard.tsx`, `BulkConfirmCard.tsx`, `UndoChip.tsx`, `SystemEventNote.tsx`
- Modify: `src/web/hooks/use-message-stream.ts`, `src/web/components/chat/MessageStream.tsx`, `src/web/lib/rpc.ts`, `src/web/routes/chat.tsx`

- [ ] **Step 1: Extend `src/web/lib/rpc.ts`.**

```ts
confirmWrite: (token: string, confirm: boolean) => fetch('/api/confirm-write', {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  body: JSON.stringify({ confirmation_token: token, confirm }),
}),
undoLast: (conversationId: string) => fetch(`/api/undo/${conversationId}`, {
  method: 'POST', credentials: 'include',
  headers: { accept: 'text/event-stream' },
}),
```

- [ ] **Step 2: Implement `src/web/components/chat/ConfirmCard.tsx`.**

```tsx
import { useState } from 'react';

type Field = { key: string; before: unknown; after: unknown };
type Preview = {
  kind: 'create_task' | 'update_task' | 'add_comment' | 'delete_task';
  target: { type: string; id: string; name: string };
  fields: Field[];
  destructive: boolean;
};

type Props = {
  preview: Preview;
  token: string;
  onResolved: () => void;
};

export function ConfirmCard({ preview, token, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const canConfirm = !preview.destructive || deleteConfirmText === 'DELETE';

  async function act(confirm: boolean) {
    setBusy(true);
    try {
      const res = await fetch('/api/confirm-write', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ confirmation_token: token, confirm }),
      });
      // read the stream so the server-side runTurn completes; we ignore the body and
      // rely on the parent reloading conversation history.
      if (res.body) {
        const reader = res.body.getReader();
        while (true) { const { done } = await reader.read(); if (done) break; }
      }
    } finally {
      setBusy(false);
      onResolved();
    }
  }

  const titleByKind: Record<typeof preview.kind, string> = {
    create_task: 'Create task in',
    update_task: 'Update task',
    add_comment: 'Comment on task',
    delete_task: 'Delete task',
  };

  return (
    <div className={`max-w-md rounded-xl border-2 p-4 my-2 ${preview.destructive ? 'border-[#f87171] bg-[#f87171]/[.06]' : 'border-[#fbbf24] bg-[#fbbf24]/[.06]'}`}>
      <div className={`text-[10px] uppercase tracking-wider font-bold mb-1 ${preview.destructive ? 'text-[#f87171]' : 'text-[#fbbf24]'}`}>
        Confirm write to ClickUp
      </div>
      <div className="text-sm font-semibold text-[#e8eaf0] mb-2">
        {titleByKind[preview.kind]}: <em>"{preview.target.name}"</em>
      </div>
      <div className="font-mono text-[11px] space-y-1 mb-3">
        {preview.fields.map((f) => (
          <div key={f.key}>
            <span className="text-[#9298ac]">{f.key}</span>{' '}
            {f.before !== null && f.before !== undefined && <span className="text-[#f87171] line-through">{String(f.before)}</span>}
            {f.before !== null && f.before !== undefined && f.after !== null && f.after !== undefined && <span className="text-[#5a6070] mx-1">→</span>}
            {f.after !== null && f.after !== undefined && <span className="text-[#34d399]">{typeof f.after === 'object' ? JSON.stringify(f.after) : String(f.after)}</span>}
          </div>
        ))}
      </div>
      {preview.destructive && (
        <input
          className="w-full mb-2 bg-[#0f1117] border border-[#2a2f3d] rounded p-2 text-xs"
          placeholder="Type DELETE to confirm"
          value={deleteConfirmText}
          onChange={(e) => setDeleteConfirmText(e.target.value)}
        />
      )}
      <div className="flex gap-2">
        <button onClick={() => act(true)} disabled={!canConfirm || busy}
          className={`px-4 py-1.5 rounded text-xs font-semibold ${preview.destructive ? 'bg-[#f87171] text-[#0a0b0f]' : 'bg-[#34d399] text-[#0a0b0f]'} ${(!canConfirm || busy) ? 'opacity-50' : ''}`}>
          Confirm
        </button>
        <button onClick={() => act(false)} disabled={busy} className="px-4 py-1.5 rounded text-xs bg-[#2a2f3d] text-[#c9cdd9]">
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement `src/web/components/chat/UndoChip.tsx`.**

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';

export function UndoChip({ onUndone }: { onUndone: () => void }) {
  const { id } = useParams();
  const [busy, setBusy] = useState(false);
  if (!id) return null;
  async function undo() {
    setBusy(true);
    try {
      const res = await fetch(`/api/undo/${id}`, { method: 'POST', credentials: 'include', headers: { accept: 'text/event-stream' } });
      if (res.body) { const r = res.body.getReader(); while (true) { const { done } = await r.read(); if (done) break; } }
    } finally { setBusy(false); onUndone(); }
  }
  return (
    <button onClick={undo} disabled={busy}
      className="text-[11px] uppercase tracking-wide rounded px-2 py-0.5 border border-[#2a2f3d] text-[#a78bfa] hover:bg-[#1a1d27]">
      {busy ? 'Undoing…' : '↶ Undo'}
    </button>
  );
}
```

- [ ] **Step 4: Implement `src/web/components/chat/SystemEventNote.tsx`.**

```tsx
type Props = { text: string; ts?: string };
export function SystemEventNote({ text, ts }: Props) {
  return (
    <div className="bg-[#60a5fa]/[.07] border-l-2 border-[#60a5fa] rounded px-3 py-1.5 text-xs text-[#c9cdd9] flex items-center gap-2">
      <span className="text-[#60a5fa] font-bold">●</span>
      <span>{text}</span>
      {ts && <span className="ml-auto text-[#5a6070]">{ts}</span>}
    </div>
  );
}
```

- [ ] **Step 5: Update `src/web/hooks/use-message-stream.ts` to handle `needs_confirmation`.**

Extend `StreamMessage`:

```ts
export type StreamMessage = {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: Array<{ tool_use_id: string; tool_name: string; router_path?: string; latency_ms?: number; ok?: boolean }>;
  pendingConfirmations: Array<{ token: string; tool_use_id: string; tool_name: string; preview: unknown }>;
  done: boolean;
};
```

In the event handler:

```ts
else if (ev.type === 'needs_confirmation') {
  draft.pendingConfirmations.push({ token: ev.confirmation_token, tool_use_id: ev.tool_use_id, tool_name: ev.tool_name, preview: ev.preview });
}
```

- [ ] **Step 6: Update `src/web/components/chat/MessageStream.tsx` to render confirm cards + system events + last-message undo chip.**

In the streaming branch, after the text, render any `pendingConfirmations`:

```tsx
{streaming.pendingConfirmations.map((p) => (
  <ConfirmCard key={p.token} preview={p.preview as any} token={p.token} onResolved={onConfirmResolved} />
))}
```

In the persisted-history rendering, render `system_event` rows via `<SystemEventNote text={m.content?.text} />`. Render `<UndoChip />` next to the last assistant message that has at least one `tool_uses` entry whose name is a write tool and where the corresponding `audit_log` entry is `undone=false` — this requires a small `audit_log` lookup endpoint or can be inferred from the message content as a simpler MVP heuristic.

- [ ] **Step 7: Wire the system-event SSE consumer in `src/web/routes/chat.tsx`.**

```tsx
useEffect(() => {
  if (!id) return;
  const es = new EventSource(`/api/conversations/${id}/events`, { withCredentials: true } as any);
  es.addEventListener('system_event', () => { void loadHistory(); });
  return () => es.close();
}, [id, loadHistory]);
```

> EventSource doesn't natively send cookies on cross-origin requests; in our same-origin deployment (Railway serves both api and assets) it works. If a separate domain is used, we'd swap to fetch + ReadableStream like the chat stream.

- [ ] **Step 8: Commit.**

```bash
git add src/web/
git commit -m "feat(web): confirm card + undo chip + system event note + stream extensions"
```

---

## Task 10: Onboarding wizard + workspace size estimator

**Files:**
- Create: `src/server/sync/workspace-estimate.ts`, `src/server/routes/onboarding.ts`, `src/web/routes/onboarding.tsx`
- Modify: `src/web/App.tsx`, `src/web/lib/rpc.ts`

- [ ] **Step 1: Implement `src/server/sync/workspace-estimate.ts`.**

```ts
import { TurnMcpPool, callMcpTool } from '../mcp/client.js';

export async function estimateWorkspaceSize(userId: string): Promise<{ approxTaskCount: number; listCount: number }> {
  const pool = new TurnMcpPool(userId);
  try {
    const session = await pool.get();
    const teamId = session.workspaceId;
    const spacesResp = await callMcpTool<{ spaces: Array<Record<string, unknown>> }>(session, 'list_spaces', { team_id: teamId });
    let listCount = 0;
    let sampledTasks = 0;
    let sampledLists = 0;
    for (const s of spacesResp.spaces ?? []) {
      const folders = await callMcpTool<{ folders: Array<Record<string, unknown>> }>(session, 'list_folders', { space_id: String(s.id) });
      for (const f of folders.folders ?? []) {
        for (const _l of (f.lists as Array<Record<string, unknown>> | undefined) ?? []) listCount++;
      }
      const folderless = await callMcpTool<{ lists: Array<Record<string, unknown>> }>(session, 'list_folderless_lists', { space_id: String(s.id) });
      for (const _l of folderless.lists ?? []) listCount++;

      // sample first 3 lists for per-list task counts
      const sample = [...((folders.folders ?? []).flatMap((f) => (f.lists as Array<Record<string, unknown>> | undefined) ?? [])), ...(folderless.lists ?? [])].slice(0, 3);
      for (const l of sample) {
        const tr = await callMcpTool<{ tasks: Array<unknown> }>(session, 'list_tasks', { list_id: String(l.id), page: 0 });
        sampledTasks += (tr.tasks ?? []).length;
        sampledLists++;
      }
    }
    const avg = sampledLists > 0 ? sampledTasks / sampledLists : 0;
    return { approxTaskCount: Math.round(avg * listCount), listCount };
  } finally {
    await pool.closeAll();
  }
}
```

- [ ] **Step 2: Implement `src/server/routes/onboarding.ts`.**

```ts
import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware.js';
import { estimateWorkspaceSize } from '../sync/workspace-estimate.js';
import { db } from '../db/client.js';
import { cuWorkspaces } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const onboardingRoutes = new Hono()
  .use('*', requireAuth)
  .get('/estimate', async (c) => {
    const u = c.get('user');
    try {
      const r = await estimateWorkspaceSize(u.id);
      return c.json(r);
    } catch (e) {
      return c.json({ error: String((e as Error).message ?? e) }, 500);
    }
  })
  .get('/sync-progress', async (c) => {
    const u = c.get('user');
    // join clickup_connections → cu_workspaces (for the user's connected workspace)
    const rows = await db.execute(`
      SELECT cw.workspace_id, cw.name, cw.last_full_sync_at, cw.sync_state
      FROM cu_workspaces cw
      JOIN clickup_connections cc ON cc.workspace_id = cw.workspace_id
      WHERE cc.user_id = '${u.id.replace(/'/g, "''")}'
        AND cc.tombstoned_at IS NULL
      LIMIT 1
    `);
    const r = (rows as unknown as Array<{ workspace_id: string; name: string; last_full_sync_at: Date | null; sync_state: Record<string, unknown> }>)[0];
    if (!r) return c.json({ status: 'pending' });
    return c.json({
      status: r.last_full_sync_at ? 'done' : 'running',
      syncState: r.sync_state,
      workspace: { id: r.workspace_id, name: r.name },
    });
  });
```

> The raw SQL with embedded user id is acceptable here because `u.id` came from authenticated middleware and is already a UUID; adjust to parameterized SQL via Drizzle if your project conventions require it.

Mount in `src/server/index.ts`:

```ts
import { onboardingRoutes } from './routes/onboarding.js';
// inside startWeb(): app.route('/api/onboarding', onboardingRoutes);
```

- [ ] **Step 3: Add onboarding RPC methods to `src/web/lib/rpc.ts`.**

```ts
estimateWorkspace: () => request<{ approxTaskCount: number; listCount: number }>('/api/onboarding/estimate'),
syncProgress: () => request<{ status: 'pending' | 'running' | 'done'; syncState?: { phase?: string; listsDone?: number; listsTotal?: number }; workspace?: { id: string; name: string } }>('/api/onboarding/sync-progress'),
```

- [ ] **Step 4: Implement `src/web/routes/onboarding.tsx`.**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/rpc.js';

type Phase = 'welcome' | 'connect' | 'estimate' | 'syncing' | 'done';

export function Onboarding() {
  const [phase, setPhase] = useState<Phase>('welcome');
  const [estimate, setEstimate] = useState<{ approxTaskCount: number; listCount: number } | null>(null);
  const [progress, setProgress] = useState<{ status: string; syncState?: { phase?: string; listsDone?: number; listsTotal?: number } } | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    api.clickupStatus().then((r) => { if (r.connected) setPhase('estimate'); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (phase !== 'estimate') return;
    api.estimateWorkspace().then((e) => { setEstimate(e); setPhase('syncing'); }).catch(() => {});
  }, [phase]);

  useEffect(() => {
    if (phase !== 'syncing') return;
    const t = setInterval(async () => {
      const p = await api.syncProgress();
      setProgress(p);
      if (p.status === 'done') { setPhase('done'); clearInterval(t); }
    }, 2000);
    return () => clearInterval(t);
  }, [phase]);

  const needsAddOn = estimate ? estimate.approxTaskCount > 250 : false;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="bg-[#181b22] border border-[#2a2f3d] rounded-2xl p-8 w-[520px]">
        {phase === 'welcome' && (
          <>
            <h1 className="text-2xl font-bold mb-2">Welcome to Tasktalk</h1>
            <p className="text-[#9298ac] text-sm mb-6">Talk to your ClickUp workspace through Claude. We'll connect your account, index your data, and get you a working chat in a few minutes.</p>
            <button onClick={() => setPhase('connect')} className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 font-semibold">Get started →</button>
          </>
        )}
        {phase === 'connect' && (
          <>
            <h1 className="text-xl font-bold mb-2">Connect ClickUp</h1>
            <p className="text-[#9298ac] text-sm mb-6">You'll be sent to ClickUp to authorize Tasktalk. We only request the scopes needed to read tasks and comment on your behalf.</p>
            <a href="/api/clickup/connect" className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 font-semibold inline-block">Connect ClickUp</a>
          </>
        )}
        {phase === 'estimate' && (
          <>
            <h1 className="text-xl font-bold mb-2">Estimating workspace size…</h1>
            <p className="text-[#9298ac] text-sm">This takes about 30 seconds.</p>
          </>
        )}
        {phase === 'syncing' && (
          <>
            <h1 className="text-xl font-bold mb-2">Indexing your workspace</h1>
            {estimate && (
              <p className="text-[#9298ac] text-sm mb-3">
                ~{estimate.approxTaskCount.toLocaleString()} tasks across {estimate.listCount} lists.
                {needsAddOn && <span className="block mt-2 text-[#fbbf24]">⚠️ Heads up: that's larger than ClickUp's default 300 calls/day rate limit can index in one shot. Consider enabling the "Everything AI" add-on, or we'll pace this across multiple days.</span>}
              </p>
            )}
            {progress?.syncState && (
              <div className="mt-4">
                <div className="text-xs text-[#9298ac] mb-2">Phase: {progress.syncState.phase ?? '…'}</div>
                {typeof progress.syncState.listsTotal === 'number' && (
                  <div className="w-full bg-[#0f1117] rounded h-2 overflow-hidden">
                    <div className="bg-[#7c6ef7] h-2 transition-all" style={{ width: `${Math.round(((progress.syncState.listsDone ?? 0) / Math.max(1, progress.syncState.listsTotal)) * 100)}%` }} />
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {phase === 'done' && (
          <>
            <h1 className="text-xl font-bold mb-2">You're ready 🎉</h1>
            <p className="text-[#9298ac] text-sm mb-6">Try a sample question to get a feel for it.</p>
            <button onClick={() => nav('/chat')} className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 font-semibold">Open chat</button>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add route to `src/web/App.tsx`.**

```tsx
<Route path="/onboarding" element={<Onboarding />} />
```

And redirect new users to `/onboarding` if `clickupStatus.connected` is false on first login (in `Settings` or a small wrapper).

- [ ] **Step 6: Commit.**

```bash
git add src/server/sync/workspace-estimate.ts src/server/routes/onboarding.ts src/server/index.ts src/web/routes/onboarding.tsx src/web/App.tsx src/web/lib/rpc.ts
git commit -m "feat(onboarding): wizard with workspace size estimate + add-on warning + progress"
```

---

## Task 11: Theme toggle + sidebar collapse + suggested prompts

**Files:**
- Create: `src/web/hooks/use-theme.ts`, `src/web/components/ui/ThemeToggle.tsx`
- Modify: `src/web/styles.css`, `src/web/routes/chat.tsx`, `src/web/routes/settings.tsx`

- [ ] **Step 1: Update `src/web/styles.css` with CSS variables for light/dark.**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg: #0a0b0f;
  --surface: #181b22;
  --surface-2: #0f1117;
  --border: #2a2f3d;
  --text: #e8eaf0;
  --text-muted: #9298ac;
  --accent: #7c6ef7;
}

[data-theme="light"] {
  --bg: #fafafa;
  --surface: #ffffff;
  --surface-2: #f5f6f8;
  --border: #e3e4e8;
  --text: #1a1d24;
  --text-muted: #6b7280;
  --accent: #6d5af0;
}

body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; }
```

> Existing `bg-[#0a0b0f]` etc. utility classes can be progressively replaced by `bg-[var(--bg)]`. For MVP, leave existing classes; the theme toggle still applies CSS variables for any new components and the `body` background.

- [ ] **Step 2: Implement `src/web/hooks/use-theme.ts`.**

```ts
import { useEffect, useState } from 'react';

type ThemeMode = 'system' | 'dark' | 'light';

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => (localStorage.getItem('tt_theme') as ThemeMode) ?? 'system');
  const [resolved, setResolved] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    function apply() {
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const r = mode === 'system' ? (sysDark ? 'dark' : 'light') : mode;
      setResolved(r);
      document.documentElement.dataset.theme = r;
    }
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mode === 'system') mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);

  function update(next: ThemeMode) {
    localStorage.setItem('tt_theme', next);
    setMode(next);
  }

  return { mode, resolved, setMode: update };
}
```

- [ ] **Step 3: Implement `src/web/components/ui/ThemeToggle.tsx`.**

```tsx
import { useTheme } from '../../hooks/use-theme.js';

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <select value={mode} onChange={(e) => setMode(e.target.value as any)}
      className="bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs px-2 py-1 text-[var(--text-muted)]">
      <option value="system">System</option>
      <option value="dark">Dark</option>
      <option value="light">Light</option>
    </select>
  );
}
```

Mount it in the Settings page (under the "ClickUp connection" section).

- [ ] **Step 4: Add a sidebar-collapse toggle in `chat.tsx`.**

```tsx
const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('tt_sidebar') !== 'closed');
useEffect(() => { localStorage.setItem('tt_sidebar', sidebarOpen ? 'open' : 'closed'); }, [sidebarOpen]);

// header right-side button:
<button onClick={() => setSidebarOpen((v) => !v)} className="text-[#9298ac] text-sm">{sidebarOpen ? '▶' : '◀'}</button>

// only render <ConversationList ... /> when sidebarOpen
```

- [ ] **Step 5: Suggested prompts on empty conversation.**

In the empty/no-history branch of the chat page, render:

```tsx
{!streaming && history.length === 0 && (
  <div className="flex-1 flex items-center justify-center">
    <div className="text-center max-w-md">
      <p className="text-[#9298ac] text-sm mb-4">Try asking</p>
      <div className="grid grid-cols-1 gap-2">
        {['What should I work on next?', 'Show me overdue tasks', "Who's overloaded?", 'What did the team ship last week?'].map((s) => (
          <button key={s} onClick={() => onSend(s)} className="text-left bg-[#181b22] border border-[#2a2f3d] rounded-md p-3 text-sm text-[#c9cdd9] hover:border-[#7c6ef7]">
            {s}
          </button>
        ))}
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 6: Commit.**

```bash
git add src/web/hooks/use-theme.ts src/web/components/ui/ThemeToggle.tsx src/web/styles.css src/web/routes/chat.tsx src/web/routes/settings.tsx
git commit -m "feat(web): theme toggle + sidebar collapse + suggested prompts"
```

---

## Task 12: Right-sidebar task context

**Files:**
- Create: `src/web/components/sidebar/TaskContextPanel.tsx`, `src/web/hooks/use-task-context.ts`
- Modify: `src/web/routes/chat.tsx`

- [ ] **Step 1: Implement `src/web/hooks/use-task-context.ts`.**

```ts
import { useMemo } from 'react';

type Msg = { role: string; content: any };

export function useTaskContext(history: Msg[]) {
  return useMemo(() => {
    const tasks = new Map<string, { id: string; name: string }>();
    for (const m of history) {
      const tu = (m.content?.tool_uses as Array<{ name: string; input: Record<string, unknown> }> | undefined) ?? [];
      for (const t of tu) {
        const id = (t.input.task_id as string | undefined);
        if (id) tasks.set(id, { id, name: id });
      }
      const taskBlob = JSON.stringify(m.content ?? '');
      // best-effort scrape of "task_id":"..." from tool results
      const matches = taskBlob.matchAll(/"task_id":"([^"]+)"[^}]*"name":"([^"]+)"/g);
      for (const m of matches) tasks.set(m[1]!, { id: m[1]!, name: m[2]! });
    }
    return Array.from(tasks.values()).slice(-8);
  }, [history]);
}
```

- [ ] **Step 2: Implement `src/web/components/sidebar/TaskContextPanel.tsx`.**

```tsx
type Task = { id: string; name: string };

export function TaskContextPanel({ tasks, asOf }: { tasks: Task[]; asOf: string | null }) {
  return (
    <aside className="w-[260px] bg-[var(--surface-2)] border-l border-[var(--border)] p-3 overflow-y-auto">
      <h4 className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] font-bold mb-2">Tasks in this conversation</h4>
      {tasks.length === 0 && <p className="text-xs text-[var(--text-muted)]">No tasks referenced yet.</p>}
      {tasks.map((t) => (
        <div key={t.id} className="bg-[var(--surface)] border border-[var(--border)] rounded p-2 mb-2 text-xs">
          <div className="font-semibold text-[var(--text)] truncate">{t.name}</div>
          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{t.id}</div>
        </div>
      ))}
      {asOf && <div className="text-[10px] text-[var(--text-muted)] mt-2 pt-2 border-t border-[var(--border)] italic">Mirror as-of {new Date(asOf).toLocaleTimeString()}</div>}
    </aside>
  );
}
```

- [ ] **Step 3: Add a right-sidebar toggle in `chat.tsx`.**

```tsx
const [rightOpen, setRightOpen] = useState(() => localStorage.getItem('tt_right') === 'open');
useEffect(() => { localStorage.setItem('tt_right', rightOpen ? 'open' : 'closed'); }, [rightOpen]);
const tasks = useTaskContext(history);

// render:
{rightOpen && <TaskContextPanel tasks={tasks} asOf={null} />}

// header toggle button:
<button onClick={() => setRightOpen((v) => !v)} className="text-[#9298ac] text-sm ml-2">{rightOpen ? 'Hide context' : 'Show context'}</button>

// responsive: at <900px, force closed
useEffect(() => {
  const mq = window.matchMedia('(max-width: 900px)');
  const apply = () => { if (mq.matches) setRightOpen(false); };
  mq.addEventListener('change', apply);
  return () => mq.removeEventListener('change', apply);
}, []);
```

- [ ] **Step 4: Commit.**

```bash
git add src/web/components/sidebar/TaskContextPanel.tsx src/web/hooks/use-task-context.ts src/web/routes/chat.tsx
git commit -m "feat(web): right-sidebar task context (collapsed by default)"
```

---

## Task 13: Dockerfile + Railway config + deploy checklist

**Files:**
- Create: `Dockerfile`, `railway.toml`, `docker-compose.yml`, `docs/superpowers/plans/deploy-checklist.md`

- [ ] **Step 1: Create `Dockerfile` (multi-stage).**

```dockerfile
# syntax=docker/dockerfile:1.6

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
```

- [ ] **Step 2: Create `railway.toml`.**

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 5

[[services]]
name = "tasktalk-web"
[services.envs]
PROCESS_ROLE = "web"

[[services]]
name = "tasktalk-worker"
[services.envs]
PROCESS_ROLE = "worker"
```

- [ ] **Step 3: Create `docker-compose.yml` (local dev).**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: tasktalk
    ports: ["5432:5432"]
    volumes: ["pg-data:/var/lib/postgresql/data"]
volumes:
  pg-data:
```

- [ ] **Step 4: Create `docs/superpowers/plans/deploy-checklist.md`.**

```md
# Tasktalk Deploy Checklist (Railway)

## Pre-deploy

- [ ] ClickUp OAuth allowlist application filed (production redirect URI: https://<your-railway-url>/api/clickup/callback)
- [ ] Resend domain verified for noreply@<your-domain>
- [ ] Anthropic API key with sufficient quota
- [ ] CLICKUP_OAUTH_CLIENT_ID + SECRET obtained from ClickUp app registration
- [ ] CLICKUP_WEBHOOK_SECRET generated (32+ random bytes, hex-encoded)
- [ ] TOKEN_ENCRYPTION_KEY generated (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- [ ] SESSION_COOKIE_SECRET generated (≥32 chars)

## Railway setup

- [ ] Create project, connect GitHub repo
- [ ] Add Postgres service (managed)
- [ ] Add `tasktalk-web` service from Dockerfile, set PROCESS_ROLE=web
- [ ] Add `tasktalk-worker` service from same Dockerfile, set PROCESS_ROLE=worker
- [ ] Inject DATABASE_URL into both services from the Postgres service variables
- [ ] Set all env vars per `.env.example` in both services
- [ ] Set BASE_URL to Railway-generated public URL
- [ ] Run drizzle migrations: from local with prod DATABASE_URL: `npm run db:push`

## Post-deploy verification

- [ ] Hit `/api/health` on web service → `{"ok":true,"role":"web"}`
- [ ] Sign in via magic link (check Resend dashboard for delivery)
- [ ] Connect ClickUp (allowlist must be approved)
- [ ] Initial sync completes; verify `cu_tasks` row count matches expectation
- [ ] Webhook fires when a task is updated in ClickUp; system event appears inline
- [ ] A query returns within P95 < 800ms on hot snapshot
- [ ] Write + confirm + undo flow works end to end
- [ ] Sentry receiving any caught errors

## Rollback plan

- [ ] Tag deploys in git: `git tag -a deploy-YYYY-MM-DD -m "..."`
- [ ] Railway "Rollback" → previous deploy
- [ ] Migration rollbacks: `drizzle/<n>_*.sql` are forward-only; for schema rollback, write a new migration that reverses the change
```

- [ ] **Step 5: Commit.**

```bash
git add Dockerfile railway.toml docker-compose.yml docs/superpowers/plans/deploy-checklist.md
git commit -m "build: Dockerfile + Railway config + deploy checklist"
```

---

## Task 14: Final integration smoke test

**Files:**
- Create: `tests/integration/full-flow.smoke.md`

- [ ] **Step 1: Write the manual smoke checklist.**

```md
# Full-flow smoke test (manual, after Plan D lands)

## Onboarding
- [ ] New invitee receives magic link, clicks, lands on `/onboarding`
- [ ] Wizard walks through Welcome → Connect → Estimate → Syncing → Done
- [ ] If workspace estimate > 250 tasks, the add-on warning shows
- [ ] Sync progress bar updates as worker indexes lists

## Read flow (regression of Plan C)
- [ ] All 8 read tools answer correctly via Claude

## Write flow
- [ ] "Mark task X as done" → confirm card with status diff → click Confirm → assistant streams confirmation message → ClickUp shows the change
- [ ] "Comment on task X: looks good" → confirm card with text → click Confirm
- [ ] "Create a follow-up task in <list>" → confirm card with new fields → click Confirm
- [ ] "Delete task X" → confirm card requires typing DELETE → button activates only after correct input
- [ ] Cancel any of the above → assistant gracefully continues without the write

## Undo
- [ ] After a successful update, click the Undo chip → before/after reverts → audit_log row marked undone

## System events
- [ ] In one tab, ask about task X. In ClickUp, change task X status. Within ~5s, an inline blue notice appears in the conversation.

## Polish
- [ ] Theme toggle: System / Dark / Light all switch
- [ ] Right sidebar collapses and persists per-account
- [ ] Tool-call pills hidden by default; hover reveals tool name + router_path
- [ ] Suggested prompts appear on empty conversation; clicking fills the composer

## Deploy
- [ ] Production deploy succeeds; both services running on Railway
- [ ] OAuth allowlist active; teammates can connect from prod URL
```

- [ ] **Step 2: Commit.**

```bash
git add tests/integration/full-flow.smoke.md
git commit -m "docs: full-flow manual smoke checklist"
```

---

## Self-Review

**Spec coverage (Sections 4 pending_writes/audit, 6 write tools, 8 write path, 9 system events + tombstone purge, 10 onboarding/theme/sidebar, 11 deploy):**

- ✓ `pending_writes` + `audit_log` tables (Task 1)
- ✓ Preview struct builder for all 4 write tools (Task 2)
- ✓ Write executor with audit pending → ok/failed flow (Task 3)
- ✓ Mirror upsert after successful write (Task 3)
- ✓ Write tools defined to Claude (Task 4)
- ✓ Pause-and-resume on writes (Task 4)
- ✓ Confirmation token, 5-minute TTL, single-use (Tasks 1, 4, 5)
- ✓ Confirm-write route with synthetic system note for turn continuation (Task 5)
- ✓ Cancel path returns user_denied (Task 5)
- ✓ Single-step undo via inverse-action handler (Task 6)
- ✓ Destructive flag + "type DELETE" gating (Tasks 2, 9)
- ✓ Bulk preview UI — note: deferred to a refinement; the spec calls for "inline list with checkboxes" for multi-task preview, while this plan ships the single-task ConfirmCard. Multi-task batches in a single Claude turn would render multiple cards in sequence, which is functionally correct. A dedicated BulkConfirmCard with checkboxes can be added later if a single tool call needs to express bulk semantics; current Claude-level granularity (one tool call per task) handles bulk work as N individual cards.
- ✓ System-event producer + consumer + persisted message (Task 7)
- ✓ Tombstone purge cron (>7 days) (Task 8)
- ✓ Theme system follow + manual override (Task 11)
- ✓ Sidebar collapse default + per-account persist (Tasks 11, 12)
- ✓ Tool pills hidden by default (Plan C, reaffirmed in walkthroughs)
- ✓ Empty-state suggested prompts (Task 11)
- ✓ Right sidebar task context (Task 12)
- ✓ Onboarding wizard with estimate + add-on warning + progress (Task 10)
- ✓ Dockerfile + Railway config + deploy checklist (Task 13)

**Plan D intentionally excludes:**
- A polished `BulkConfirmCard` with checkbox-deselect — current behavior is one card per Claude tool call which is what Claude actually emits. Add only if real users encounter genuinely-bulk single tool calls.
- Cross-conversation memory (Phase 2)
- Mobile companion apps (Phase 2)

**Placeholder scan:** No `TBD` or `TODO`. Several risk callouts noted in line:
- Anthropic SDK streaming API surface (already noted in Plan C)
- ClickUp REST endpoint paths for webhooks (verify against docs)
- ClickUp MCP tool name verification (check `client.listTools()` at runtime)
- The synthetic `[system: ...]` user message pattern in confirm-write — works but can be refined to a proper `tool_result` block in a follow-up if it bleeds into the assistant's voice.

**Type consistency:**
- `Preview` shape returned by `buildPreview` matches `ConfirmCard` props
- `WriteResult` shape returned by `executeWrite` matches what confirm-write writes to `messages` and `auditLog`
- `TurnEvent` `needs_confirmation` shape matches frontend handler
- `SystemEventPayload` shape matches what `broadcastSystemEvent` notifies and what `subscribeForUserConversation` receives

**Real risks captured for the implementer:**
1. Postgres LISTEN/NOTIFY payloads have an 8000-byte limit; our `SystemEventPayload` is small enough but worth confirming if more fields are added later.
2. EventSource cookie behavior in cross-origin deploys; same-origin Railway works.
3. `audit_log.action` enum includes `'undo'` — when the original write is undone, both rows exist and link via `undo_target_id`. Don't double-mark.

---

## What Plan D produces

After completing all 14 tasks: a deployable, production-ready MVP. A small team can be onboarded, connect their ClickUp, ask Claude questions about their work, and direct Claude to make changes in ClickUp via preview-and-confirm workflows with full audit trail and one-click undo. The app self-heals via webhooks + drift, respects ClickUp's rate limits, and tells users honestly when it's working from stale data. Theme follows system preference; UI scales to mobile browser. Two Railway processes (web + worker), one Postgres, deployed from a single repo on `git push`.

---

## End of plan series

Plans A–D together implement the full spec at `docs/superpowers/specs/2026-05-01-tasktalk-design.md`. Total: 4 plan documents, ~52 tasks, ~250 steps.

**Recommended execution path:**
- Use `superpowers:subagent-driven-development` to dispatch one fresh subagent per task. The two-stage review pattern catches drift earlier than batch execution.
- Land Plan A end-to-end before starting Plan B (each plan ends in a working milestone you can sanity-test before stacking the next layer).
- Run the smoke checklists after each plan; they're the cheapest verification you can buy.
