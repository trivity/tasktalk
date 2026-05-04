import { pgTable, uuid, text, timestamp, boolean, integer, bigint, index, uniqueIndex, jsonb, primaryKey, date } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    passwordHash: text('password_hash'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ emailIdx: uniqueIndex('users_email_idx').on(t.email) }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index('sessions_user_idx').on(t.userId) }),
);

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['magic_link', 'password_reset'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tokenIdx: uniqueIndex('auth_tokens_hash_idx').on(t.tokenHash) }),
);

export const clickupConnections = pgTable(
  'clickup_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    scopes: text('scopes'),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('cu_conn_user_idx').on(t.userId),
    userWsActiveIdx: uniqueIndex('cu_conn_user_ws_active_idx')
      .on(t.userId, t.workspaceId)
      .where(sql`${t.tombstonedAt} IS NULL`),
  }),
);

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

export const userAiCredentials = pgTable(
  'user_ai_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['anthropic', 'openai'] }).notNull(),
    apiKeyEnc: text('api_key_enc').notNull(),
    modelPreference: text('model_preference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userProviderIdx: uniqueIndex('user_ai_creds_user_provider_idx').on(t.userId, t.provider),
  }),
);
