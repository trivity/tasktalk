# Tasktalk — Conversational ClickUp Assistant

**Spec date:** 2026-05-01
**Status:** Design approved; pending implementation plan
**Project root:** `C:\Users\trivi\OneDrive\Desktop\AI WEBSITES\Tasktalk`

---

## 1. Overview

Tasktalk is a web app that lets a small team converse with their ClickUp workspace through Claude. Users ask questions ("*what should I work on next?*", "*who's overloaded?*", "*what shipped last week?*") and Claude answers using their actual ClickUp data via ClickUp's official MCP server. Users can also direct Claude to write back to ClickUp — create tasks, change status, comment, delete — with every write going through a preview-and-confirm step backed by an audit log and single-step undo.

The MVP is a desktop-first web app for an internal team (no public signup) with multi-tenant-ready architecture so a productized SaaS version is a feature-add later, not a rewrite. iOS and Android companion apps and voice input/output are deferred to Phase 2.

### What problem this solves

ClickUp is rich but click-heavy. Aggregate questions ("*how is the team tracking?*") require navigating to dashboards. Daily-planning questions ("*what should I work on right now?*") require reading several lists and applying mental filters. Tasktalk shifts that into a single conversational surface where Claude does the navigation and reasoning, and the team gets answers in seconds.

### What this is not

- Not a generic "talk to your task tool" app. It's ClickUp-specific in MVP. Other tools could be added later, but the abstraction tax is not paid up front.
- Not a public SaaS in MVP. Internal team only, invite-only access.
- Not voice-first. Text-only on web. Voice lands with the mobile companion apps in Phase 2.
- Not a replacement for ClickUp. Tasktalk reads/writes to ClickUp; ClickUp remains the source of truth.

---

## 2. Confirmed decisions (from brainstorming)

These are the choices made during clarifying dialogue. They drive every section that follows.

| Decision | Choice |
|---|---|
| Integration target | ClickUp's official hosted MCP server (`mcp.clickup.com/mcp`), OAuth 2.1 + PKCE only |
| Audience | Internal team tool, no public signup, architected so SaaS is a feature-add |
| Capabilities | Full read + write with preview-confirm, audit log, single-step undo |
| Voice | Deferred to mobile companion apps; text-only on web |
| Query scope | Self queries + team-wide aggregates; no named-person drill-down |
| Conversation persistence | ChatGPT-style — every conversation saved, browseable, resumable; no cross-conversation memory |
| ClickUp data scope | Core task surface (tasks, subtasks, status, assignees, due dates, priorities, tags, descriptions, lists/folders/spaces, members, comments) **+ custom fields** |
| Deployment | Cloud platform — specifically Railway |
| Architecture | Hybrid Router (Approach 3) — snapshot mirror with a live-MCP fallback path, plus all writes live |
| App auth | Magic links **+** passwords (both supported, user picks per login) |
| ClickUp disconnect | Tombstone mirror data with 7-day grace period before purge |
| Router freshness threshold | 5 minutes — snapshot if `last_incremental_sync_at` is within 5 min, else live (which also queues a sync) |
| `add_comment` confirmation | Keep it (consistency over speed) |
| Bulk preview UI | Inline list with per-item checkboxes inside the chat |
| Undo | Single-step only (most recent write); multi-step deferred to Phase 2 |
| Drift reconciliation cadence | Daily |
| Webhook → conversation pipe | Live, inline as `role="system_event"` messages in active conversation |
| Theme | System-following with manual override toggle in settings |
| Right sidebar default | Collapsed; user preference persists per-account |
| Tool-call interstitial pills | Hidden by default; revealed on hover/expand |
| Anthropic SDK | Raw `@anthropic-ai/sdk` (not the Agent SDK) |
| MCP session lifetime | Per-turn pooling — open at start of Claude turn, share across that turn's tool calls, close at end |

---

## 3. System architecture

Six components, one external service:

- **Frontend (SPA)** — chat UI, conversation history sidebar, settings, ClickUp OAuth callback page. Streams responses from backend over SSE. Never holds Anthropic or ClickUp credentials; every external call is brokered by the backend.
- **Backend (Node API)** — orchestrator. Holds Anthropic API key, holds users' encrypted ClickUp refresh tokens, runs the Claude tool-use loop, owns the Hybrid Router that decides snapshot vs live per tool call, writes the audit log, serves the SPA.
- **Postgres** — single database with two logical groups: app data (users, sessions, conversations, messages, audit log) and ClickUp mirror (per-workspace snapshot of tasks, lists, custom fields, members).
- **Claude API** — Anthropic. Receives user message + conversation history + tool definitions; returns text or tool calls. Streamed back through the backend.
- **ClickUp MCP** (hosted, external) — `mcp.clickup.com/mcp`. OAuth 2.1 + PKCE per user. Used for: live reads when the router picks live, all writes, and the worker's sync passes.
- **Worker** — separate Node process, same codebase. Handles initial sync on connect, processes ClickUp webhook events to keep the mirror current, runs daily drift reconciliation.

### Invariants

1. Frontend never holds Anthropic or ClickUp credentials. All external traffic flows through the backend.
2. Multi-tenancy boundary is the **workspace**: app rows reach `user_id`; mirror rows reach `workspace_id`; `clickup_connections` joins the two. Many users sharing one workspace later requires no schema change.

---

## 4. Data model

Single Postgres database. Two logical groups, one connection.

### App tables

| Table | Purpose |
|---|---|
| `users` | App user accounts. Columns: `id`, `email`, `name`, `password_hash` (nullable for magic-link-only users), `created_at`, `updated_at`. |
| `sessions` | HttpOnly cookie sessions. Columns: `id` (opaque), `user_id`, `expires_at`, `created_at`. |
| `auth_tokens` | Magic-link + password-reset tokens. Columns: `id`, `user_id`, `purpose` (`magic_link` / `password_reset`), `token_hash`, `expires_at`, `consumed_at`. |
| `clickup_connections` | Per-user OAuth credentials. Columns: `id`, `user_id`, `workspace_id`, `access_token` (encrypted), `refresh_token` (encrypted), `expires_at`, `scopes`, `created_at`, `tombstoned_at` (nullable). |
| `conversations` | Chat threads. Columns: `id`, `user_id`, `title`, `created_at`, `last_message_at`. |
| `messages` | User + assistant + tool + system_event messages. Columns: `id`, `conversation_id`, `role` (`user`/`assistant`/`tool`/`system_event`), `content` (text or JSON), `created_at`. |
| `tool_calls` | One row per Claude tool invocation. Columns: `id`, `message_id`, `tool_name`, `args` (JSONB), `result` (JSONB), `router_path` (`snapshot`/`live`/`snapshot · live-fallback`), `latency_ms`, `created_at`. |
| `audit_log` | Every accepted write to ClickUp. Columns: `id`, `user_id`, `conversation_id`, `message_id`, `action`, `target_type`, `target_id`, `before` (JSONB), `after` (JSONB), `status` (`pending`/`ok`/`failed`), `undone` (bool), `undo_target_id` (nullable FK), `created_at`. |
| `pending_writes` | In-flight write previews awaiting confirmation. Columns: `confirmation_token` (UUID PK), `user_id`, `conversation_id`, `tool_name`, `args` (JSONB), `expires_at` (5 min from creation). |

### Mirror tables (per ClickUp workspace, all keyed by `workspace_id`)

| Table | Purpose |
|---|---|
| `cu_workspaces` | One row per connected workspace. Columns: `workspace_id` (PK), `name`, `last_full_sync_at`, `last_incremental_sync_at`, `last_drift_count`, `sync_state` (JSONB). |
| `cu_spaces` / `cu_folders` / `cu_lists` | Org structure. Columns: `id`, `workspace_id`, `parent_id`, `name`, `archived`, `deleted_at` (nullable). |
| `cu_tasks` | Central table. Columns: `task_id` (PK), `list_id`, `parent_task_id` (nullable, for subtasks), `name`, `description`, `status`, `priority`, `due_date`, `start_date`, `time_estimate`, `time_spent`, `assignees` (JSONB), `tags` (JSONB), `completed_at` (nullable), `updated_at_clickup`, `deleted_at` (nullable). |
| `cu_custom_fields` | Field definitions per scope. Columns: `custom_field_id` (PK), `scope_id` (list/folder/space), `scope_type`, `name`, `type`, `config` (JSONB). |
| `cu_task_custom_field_values` | Per-task field values. Columns: `task_id`, `custom_field_id`, `value` (JSONB). PK is `(task_id, custom_field_id)`. |
| `cu_members` | Workspace members. Columns: `member_id` (PK), `workspace_id`, `name`, `email`, `role`. |

### Indexes

- `cu_tasks`: `(workspace_id, list_id, status)`, `(workspace_id, due_date)`, `(workspace_id, completed_at)`, GIN on `assignees`, `(updated_at_clickup)`.
- `cu_task_custom_field_values`: `(task_id)`, `(custom_field_id)`.
- `messages`: `(conversation_id, created_at)`.
- `audit_log`: `(user_id, created_at)`, `(conversation_id, created_at)`.
- `tool_calls`: `(message_id)`.

### Cross-cutting rules

1. **Multi-tenancy boundary.** Every app row reaches `user_id`. Every mirror row reaches `workspace_id`. Query helpers always inject the boundary; Claude tool args are never trusted to scope a query.
2. **Token encryption.** `access_token` and `refresh_token` columns are encrypted at the application layer using `TOKEN_ENCRYPTION_KEY` from env before write, decrypted on read. A DB dump alone does not expose live ClickUp credentials.
3. **Soft-delete on mirror.** When ClickUp removes a task, the mirror row gets `deleted_at` stamped. Audit log entries can resolve `target_id` even after deletion.
4. **Tombstone on disconnect.** `clickup_connections` row gets `tombstoned_at` set; mirror tables for that workspace also stamp `deleted_at`. A daily job purges anything tombstoned > 7 days ago.

---

## 5. Auth

Two independent layers. Layer 1 logs you into the app. Layer 2 connects the app to a ClickUp workspace.

### Layer 1 — App login (magic link + password)

Internal team tool, no public signup. An admin invites by email; the user can sign in by either flow.

- **Invite flow.** Admin enters teammate's email on the Members page. Backend creates a `users` row with `status=invited`, no `password_hash`, and emails a magic link. Provider: Resend.
- **Magic link.** Single-use, 15-minute token in `auth_tokens` (`purpose=magic_link`). User clicks → backend validates token → creates session → sets `HttpOnly + Secure + SameSite=Strict` cookie with opaque session ID.
- **Password.** User can set a password from settings after first login. Login screen accepts either: email + "Send magic link" button, or email + password fields. Argon2id hashing.
- **Session.** Stored in `sessions` table (opaque IDs, not JWTs — easier revocation). 7-day max lifetime, sliding window on activity. Expired session → fresh magic link or password.
- **Password reset.** Reuses `auth_tokens` with `purpose=password_reset`.

### Layer 2 — ClickUp OAuth

ClickUp MCP exclusively supports OAuth 2.1 + PKCE; API tokens are explicitly disallowed.

1. User clicks "Connect ClickUp" in settings. Backend generates `code_verifier` (random) + `code_challenge` (SHA256). Stores verifier in session.
2. Browser redirects to ClickUp authorize URL with `client_id`, `redirect_uri`, `code_challenge`, `state`.
3. User approves on ClickUp's domain. ClickUp redirects to `/auth/clickup/callback?code=...&state=...`.
4. Backend validates `state`, exchanges `code + code_verifier` for `access_token + refresh_token`, encrypts both, stores in `clickup_connections`.
5. **Auto-refresh.** Before any MCP call, if `expires_at < now + 60s`, exchange refresh_token for a fresh access_token transparently. User never sees a "reconnect" prompt mid-session for at least 7 days.

### Allowlist constraint

ClickUp keeps an allowlist of vetted client redirect URIs. **The allowlist application must be filed early in the build**, not late — production launch can be blocked by waiting on ClickUp. Localhost dev URIs are typically allowlistable without delay.

### Disconnect

- **Logout** — delete session row, clear cookie.
- **Disconnect ClickUp** — delete `clickup_connections` row, revoke at ClickUp, stamp `tombstoned_at`. Mirror tables stamped `deleted_at`. Daily purge job hard-deletes rows tombstoned > 7 days. If user reconnects within 7 days, mirror is restored without a full re-sync.
- **Account delete** — cascades through both layers. UX deferred to Phase 2.

---

## 6. Conversational layer + Hybrid Router

### Tool inventory

12 tools, four lanes by routing rule.

**Always-snapshot** (read from Postgres mirror, zero MCP cost):
- `list_workspaces()`
- `list_org_structure()` — Spaces / Folders / Lists tree
- `aggregate_workload({group_by, filters})` — "who's overloaded?"
- `aggregate_throughput({since, until, group_by})` — "what shipped last week?"
- `get_team_members()`
- `list_custom_fields(scope_id)`

**Always-live** (every call hits MCP):
- `get_task(task_id)` — single-task lookup, freshness-critical

**Router-decided** (snapshot if mirror fresh, else live):
- `query_tasks({list_id?, assignee?, status?, due_before?, due_after?, has_tag?, custom_fields?, ...})`

**Writes** (always live, always preview-confirm, all logged to `audit_log`):
- `create_task({list_id, name, description?, due_date?, ...})`
- `update_task({task_id, patch: {status?, due_date?, assignees?, custom_fields?, ...}})`
- `add_comment({task_id, text})`
- `delete_task({task_id})` — extra "type DELETE" step

**Comment reads:** `get_task(task_id)` returns recent comments inline as part of the task payload. A dedicated `get_task_comments(task_id, since?)` tool for full comment-thread browsing is **not in MVP** — comments visible via task detail covers the common case ("*what's the latest on this task?*"). Promote to a tool in Phase 2 if rich comment workflows become valuable.

### Router rules

```
aggregate_*                       → always snapshot
get_task(id)                      → always live
query_tasks(filters)              → snapshot if last_incremental_sync_at > now − 5 min, else live (also queues sync)
list_*                            → always snapshot
create/update/delete/add_comment  → always live + invalidate mirror row
```

### Turn lifecycle

1. User submits a message.
2. Backend assembles context: system prompt + workspace summary + last N messages + tool definitions.
3. Stream from `messages.create` (Anthropic raw SDK).
4. **Read tool call:** router picks snapshot or live → execute → append result → continue Claude loop.
5. **Write tool call:** SSE emits `needs_confirmation` event with preview struct + `confirmation_token`. Frontend renders inline preview card. User confirms → SSE resumes → MCP call → `audit_log` row written → mirror upserted. Deny → `tool_result: user_denied` to Claude.
6. End-of-turn: persist messages, `tool_calls` (with `router_path`, `latency_ms`), audit log entries.

### Technical choices

- **Anthropic raw SDK** (`@anthropic-ai/sdk`). Not the Agent SDK — Agent SDK assumes everything goes through MCP and abstracts away the router decision.
- **Model:** Claude Sonnet 4.6 default. Opus 4.7 (1M context) reserved for any future "deep analysis" mode.
- **Prompt caching** on system prompt + workspace summary block. Realistic 30–50% cost reduction on repeat turns. Per global guidance for Anthropic SDK apps.
- **Streaming** via SSE backend → frontend. Frontend renders progressively + shows tool-call interstitial pills (hidden by default, hover/expand to reveal).
- **Max 8 tool-use iterations per turn** as a safety cap. Beyond that, Claude returns a "let me simplify…" message.
- **MCP session lifetime: per-turn pooling.** Open one MCP session lazily on the first MCP-needing tool call in a Claude turn, share across all subsequent tool calls in that turn, close at end. Saves ~100–300ms per tool call vs. per-call sessions; avoids the lifecycle complexity of a global pool. **Edge case:** a turn paused on a write-confirmation may exceed the MCP session timeout while waiting for user input. If the session is closed when the turn resumes, the next MCP call transparently reopens it — no user impact.

---

## 7. Read path

Two paths, identical output shape.

### Snapshot path

- Translate `query_tasks(filters)` → one parameterized SQL statement against `cu_*` tables.
- `WHERE workspace_id = $userWorkspaceId` is enforced in a query helper, never trusted from Claude args.
- Custom-field filters use JSONB operators (`@>`, `->>`).
- Stamp result with `data_source: "snapshot"` and `as_of: last_incremental_sync_at`.

### Live path

- `@modelcontextprotocol/sdk` MCP client opens session against `mcp.clickup.com/mcp` with the user's decrypted access_token.
- Invoke matching ClickUp MCP tool.
- Stamp result with `data_source: "live"` and `as_of: now()`.
- Async upsert results into mirror tables (so subsequent snapshot reads benefit).

### Normalized result shape (Claude sees identical JSON either path)

```json
{
  "data_source": "snapshot" | "live" | "snapshot · live-fallback",
  "as_of": "2026-05-01T14:32:08Z",
  "results": [ { "task_id": "...", "name": "...", "status": "...", "priority": 2, "due_date": "...", "assignees": [...], "list": {...}, "custom_fields": {...} } ],
  "truncated": false,
  "total_estimate": 42,
  "fallback_reason": "..."
}
```

### Fallback decision tree

- Snapshot chosen, mirror fresh → return snapshot result.
- Snapshot chosen, mirror stale (`last_incremental_sync_at < now − 5 min`) → switch to live, return live result, queue async sync.
- Snapshot chosen, mirror empty (first-run) → live + queue initial-sync, stamp `first_run: true` so Claude can tell the user "still indexing."
- Live chosen, ClickUp returns 429 / 5xx → retry once with 250ms jitter → still failing → fall back to snapshot, stamp `data_source: "snapshot · live-fallback"`, populate `fallback_reason`. Claude phrases the staleness honestly.
- Both fail → return structured error result; Claude phrases as "ClickUp is rate-limited; I can re-try once the mirror catches up."

### Aggregations are snapshot-only

`aggregate_workload` is one SQL `GROUP BY assignee_id`. Via MCP it would be 50–200 calls. Not viable. **Aggregates always read snapshot regardless of staleness** — staleness is signaled to Claude via `as_of`, not avoided by switching paths. **No live fallback for aggregates.** If the mirror is empty (first-run case only), return `first_run: true` and Claude says "still indexing, ask again in a minute."

---

## 8. Write path

Every Claude write goes through preview → confirm → execute → audit. Concurrency safe via single-use confirmation tokens.

### Lifecycle (9 steps)

1. Claude returns `tool_use: update_task(task_id, patch)`.
2. Backend reads current state from mirror (or live if needed), builds **preview struct**: target task name + per-field before/after.
3. Backend mints `confirmation_token` (UUID), inserts `pending_writes` row with TTL = 5 min.
4. SSE emits `{type: "needs_confirmation", token, preview}` to frontend.
5. User clicks **Confirm** → POST `/api/confirm-write` with token. Token validated for single-use + non-expiry (409 on reuse, 404 on expiry).
6. Backend writes `audit_log` row with `status="pending"`, snapshots `before`.
7. Live MCP call. On success: fetch updated task, snapshot `after`, flip log to `status="ok"`, upsert mirror row.
8. SSE resumes Claude's turn with `tool_result: success`. Final user-facing text streams.
9. Cancel path: pending row deleted, `tool_result: user_denied` returned, Claude adapts.

### Destructive writes

- `delete_task` confirm card requires the user to type `DELETE` in a small input before the Confirm button activates.
- Bulk operations (e.g., "*reschedule all my Friday tasks*") show an **inline list of all affected items with per-item diffs and checkboxes**. User can deselect any before confirming. Inline (not modal) — keeps everything in the conversation flow.

### Audit log content

Every accepted write produces one `audit_log` row with: `action`, `target_type`, `target_id`, full `before` JSON, full `after` JSON (or null for create/delete), `status` (`pending`/`ok`/`failed`), `undone` bool, `undo_target_id` FK.

### Undo (single-step only in MVP)

- Trigger: user types "*undo that*" or clicks an Undo chip on the relevant assistant message.
- Backend looks up most recent `audit_log` row in conversation with `undone=false`, generates inverse:
  - `create_task` → `delete_task`
  - `update_task` → `update_task` with `before` values
  - `add_comment` → `delete_comment`
  - `delete_task` → recreate from `before` JSON. **UX warns**: attachments, watchers, time-tracking entries can't always be perfectly restored.
- Inverse **skips the confirmation modal** (user explicitly asked to undo). Still produces an audit log row.
- Original row marked `undone=true`, `undo_target_id` linked to the inverse row.

Multi-step undo ("undo the last 3 things") is deferred to Phase 2.

---

## 9. Sync layer

Three sync paths feed the mirror, all running through pg-boss (Postgres-backed job queue, no Redis dependency).

### Initial sync (once per ClickUp connection)

- Triggered post-OAuth. Returns immediately with "Indexing your workspace…" + progress bar.
- Worker walks dependency tree: workspace → spaces → folders → lists → tasks (paginated) → custom field values → members.
- Throttled to respect rate limit budget.
- Progress published to `cu_workspaces.sync_state` JSON, e.g. `{phase: "tasks", lists_done: 12, lists_total: 47}`. Frontend polls every 2s (or via existing SSE channel).
- On done: stamps `last_full_sync_at` and `last_incremental_sync_at`. Mirror is live.

**Rate-limit pressure.** A 5k–50k task workspace will blow the 300/24h default rate limit in one initial sync. **Onboarding estimates workspace size and warns user if their plan needs ClickUp's "Everything AI" add-on.** Without it, we offer to pace sync across multiple days (sync N lists per day until done).

### Webhook stream (real-time)

- After initial sync, register workspace-level webhook → `/api/webhooks/clickup`.
- Subscribed events: `taskCreated`, `taskUpdated`, `taskDeleted`, `taskStatusUpdated`, `taskAssigneeUpdated`, `taskCommentPosted`, `customFieldUpdated`.
- Signature verified using shared secret.
- Each event → `sync-task` pg-boss job (deduped on `task_id` within a 1s window so rapid sequential edits collapse).
- Worker fetches affected task's full state, upserts mirror.
- Stamps `last_incremental_sync_at = now()` — the value the router checks for "fresh enough."
- **Webhooks are per-workspace, not per-user.** When multiple app users share one ClickUp workspace later, one subscription suffices. Last user to disconnect deregisters.

### Drift reconciliation (daily)

- pg-boss cron runs once daily per connected workspace.
- For each list: fetch tasks `updated_at > mirror.last_incremental_sync_at`. Compare, upsert any drift.
- Records `last_drift_count`. Persistent non-zero → operator alarm (webhook subscription likely broken).

### System events into conversations

When a webhook fires for a task that was mentioned in the user's currently-active conversation (within last 20 messages), the backend pushes a `role="system_event"` message into that conversation via SSE. Persisted in `messages` so it appears in conversation history later. Filtering rules:

- Mentioned in current conversation, OR
- Assigned to the asking user, OR
- In a list the user just queried about (within last 5 minutes)

Otherwise the update is quiet (mirror only, no UI surface).

### Worker architecture

- **Two processes, one codebase.** Web process: HTTP API + SSE + webhook receiver + enqueues jobs. Worker process: pulls + executes pg-boss jobs.
- Same git repo, role chosen at boot via `PROCESS_ROLE=web|worker`.
- Why split: web stays responsive even when sync is hot; worker scales independently.
- Why pg-boss over BullMQ/Redis: no new infra dependency, durable + transactional with mirror writes, built-in cron.

---

## 10. UI/UX

ChatGPT-style three-column layout.

### Main chat layout

- **Left sidebar** — conversations grouped Today / This week / Earlier. New-conversation button at top. User account at bottom.
- **Center** — chat stream. User messages right-aligned in pills. Assistant messages left-aligned, plain text. Tool-call interstitials shown as small pills (hidden by default; revealed on hover/expand). System events render inline as a blue-bordered notice with dot icon and timestamp. Confirmation cards inline (not modal) with yellow border, before/after diff, Confirm/Cancel.
- **Right sidebar** — task context. Tasks Claude has touched in this conversation, with quick metadata. Footer line "Mirror as-of HH:MM UTC" makes data freshness explicit. **Collapsed by default**, user preference persists per-account.
- **Composer** — single text input. Shift+Enter = newline, Enter = send.

### Other screens

- **Login** — email field with two buttons: "Send magic link" + "Use password" (toggle reveals password field for second flow).
- **Onboarding wizard** — single page: (1) Welcome, (2) Connect ClickUp [OAuth redirect], (3) Pick workspace, (4) Indexing progress + size estimate + add-on warning if needed, (5) "Try a sample question."
- **Settings** — tabs: Profile (name, email, password set/change), Connections (ClickUp connect/disconnect, mirror size, last sync, theme toggle), Members (admin only — invite UI), Audit log (browseable with filter by conversation/date).
- **Empty states** — first-time user sees suggested prompts ("What should I work on?", "Show overdue tasks", "Who's overloaded?"). Click to fill composer.

### Visual style

- **System-following theme** (light/dark via `prefers-color-scheme`) with a manual override toggle in settings (per-account).
- Purple primary accent. Tailwind + shadcn/ui primitives.

### Responsive

- < 900px: right sidebar auto-collapses regardless of preference.
- < 640px: left sidebar becomes a drawer.
- Web stays usable on phone for read-only checks. Dedicated mobile companion app is Phase 2.

---

## 11. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20 LTS | Long-running process for SSE + workers |
| Language | TypeScript | End-to-end type safety with Hono RPC |
| Frontend | React 18 + Vite 5, Tailwind, shadcn/ui, TanStack Query, React Router 6 | Fastest dev loop; copy-pasted primitives |
| Backend | Hono, Zod, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, pg-boss | Hono RPC = compile-time API contract |
| Data | Postgres 16 (Railway managed), Drizzle ORM, drizzle-kit migrations | Lighter than Prisma, raw SQL we can review |
| External | Anthropic API (Sonnet 4.6), ClickUp MCP, Resend (magic links) | — |
| Hosting | Railway (app + Postgres in one dashboard) | Friendliest deploy + managed Postgres + worker dynos. Vercel ruled out due to function timeouts vs. SSE/initial-sync requirements. |
| Quality | Vitest, ESLint, Prettier, `tsc --noEmit` in CI; Sentry for runtime errors. Playwright deferred to Phase 2. | — |

### Repo structure (single TypeScript monorepo)

```
tasktalk/
├── package.json
├── tsconfig.json
├── src/
│   ├── server/             # Hono app
│   │   ├── index.ts        # entry; PROCESS_ROLE picks web|worker
│   │   ├── routes/         # auth, conversations, write-confirm, webhooks
│   │   ├── claude/         # turn loop, tool defs, router
│   │   ├── mcp/            # ClickUp MCP client wrapper, OAuth
│   │   ├── sync/           # pg-boss handlers: initial, webhook, drift
│   │   └── db/             # Drizzle schema + queries
│   ├── web/                # Vite React app
│   │   ├── index.html
│   │   ├── routes/         # chat, settings, login, onboarding
│   │   ├── components/     # Composer, MessageStream, ConfirmCard, ...
│   │   └── lib/            # Hono RPC client, hooks
│   └── shared/             # Zod schemas reused front + back
├── drizzle/                # SQL migrations
├── tests/
└── .github/workflows/
```

### Deployment topology

- `tasktalk-web` (Railway service) — Hono API + SSE + webhook endpoint + serves built React assets.
- `tasktalk-worker` (Railway service) — pg-boss consumer for `initial-sync`, `sync-task`, `drift-reconcile`.
- Same Docker image. `PROCESS_ROLE` env picks the role at boot. `git push` deploys both.

### Environment variables (full set)

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (Railway-injected) |
| `ANTHROPIC_API_KEY` | Claude API |
| `CLICKUP_OAUTH_CLIENT_ID` | OAuth registration |
| `CLICKUP_OAUTH_CLIENT_SECRET` | OAuth registration |
| `CLICKUP_WEBHOOK_SECRET` | Webhook signature verification |
| `RESEND_API_KEY` | Magic-link emails |
| `TOKEN_ENCRYPTION_KEY` | Encrypts ClickUp tokens at rest |
| `SESSION_COOKIE_SECRET` | HMAC for cookie integrity |
| `SENTRY_DSN` | Error tracking |
| `PROCESS_ROLE` | `web` or `worker` |
| `BASE_URL` | Used in magic-link emails + OAuth redirects |

---

## 12. Phasing

### Phase 1 — MVP (sub-phases, sequenced)

1. Foundation: repo, Drizzle schema, Hono skeleton, Vite shell, env config.
2. App auth: magic-link + password, sessions, members admin page.
3. ClickUp OAuth: connect flow, token encryption, settings UI for connect/disconnect.
4. Mirror schema + initial sync (CLI-triggered first, no UI).
5. Webhook receiver + sync-task handler + drift cron.
6. Read path: snapshot queries, MCP client wrapper, `query_tasks` tool.
7. Chat UI shell: conversations list, message stream, composer, SSE wiring.
8. Claude tool loop: system prompt, tool defs, prompt caching, raw SDK.
9. Aggregates + remaining read tools.
10. Write path: preview, confirm token, audit log, undo, all 4 write tools.
11. Onboarding wizard + size-based add-on warning + progress UI.
12. Polish: theme toggle, sidebar collapse, hover-expand tool pills, empty states, system events inline.

Each sub-phase is shippable and exercised before the next lands.

### Phase 2 — Companion + voice (post-MVP)

- iOS + Android companion apps (native shells around webview or React Native).
- Voice input/output (push-to-talk on mobile, optional TTS).
- Multi-step undo.
- Live notifications for tasks outside current conversation (toasts in sidebar).
- Cross-conversation memory (long-term user/team facts).
- Tool-call developer mode (pinned-open pills, latency dashboard).

### Phase 3 — Productize / SaaS (if)

- Public signup + email verification + Stripe billing.
- Multi-workspace per user (lift 1:1 constraint, add workspace switcher).
- Workspace sharing (many app users on one ClickUp workspace).
- Named-person queries with permission gating.
- Conversation sharing + read-only links.
- White-labeling + custom domains.
- Enterprise SSO (SAML, Okta).

### Backlog (not designed for unless requested)

- Multi-language support (i18n).
- Custom Claude model picker per conversation.
- Direct ClickUp REST integration as MCP fallback.
- Slack/Discord bot frontends sharing the backend.
- A/B testing framework, feature flag system.

---

## 13. "MVP done" criteria

### Functional

- 3–5 real teammates onboarded; each connected their own ClickUp via OAuth.
- Initial sync completed for every member, mirror up to date.
- Daily usage: each member runs at least one query a day for a week without error.
- Every write operation tested with real ClickUp data; confirmation + undo verified end-to-end.
- System events fire inline when relevant tasks change in ClickUp.
- Aggregate queries ("who's overloaded?", "what shipped last week?") return correct results.

### Non-functional

- P95 snapshot read latency < 800ms; P95 streamed first-token latency < 1.5s.
- Zero data-loss incidents (audit log retains all writes; `before`/`after` snapshots verified).
- OAuth token refresh works transparently — no user sees "reconnect" mid-session for 7+ days.
- Webhook drift detection: `last_drift_count = 0` for at least 5 consecutive days.
- Sentry shows no unhandled errors over 7 consecutive days.

---

## 14. ClickUp MCP constraints (reference)

Captured here so they're easy to find when implementation starts:

- **Endpoint:** hosted, `https://mcp.clickup.com/mcp` (HTTP/SSE, MCP standard).
- **Auth:** OAuth 2.1 + PKCE only. API tokens are explicitly disallowed.
- **Allowlist:** ClickUp keeps a vetted allowlist of redirect URIs. Allowlist application must be filed early.
- **Rate limits:** Free plan = 50 calls/24h. Paid plan = 300 calls/24h. With "Everything AI" add-on = standard public API rate limits (much higher). Rolling 24-hour windows, cannot be reset.
- **Status:** Public beta — APIs may change.
- **Tool surface:** task management, time tracking, documentation access, comments. (Full list in ClickUp's docs; we use a subset matching our 12-tool inventory.)

These constraints are why the architecture defaults to the snapshot mirror and treats live MCP as a precise, narrow fallback.
