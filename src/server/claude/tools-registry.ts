import type Anthropic from '@anthropic-ai/sdk';

export const ANTHROPIC_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_workspaces',
    description: 'List every ClickUp workspace the user is connected to. The user may have one or many.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_org_structure',
    description: 'Return the workspace as a tree of Spaces -> Folders -> Lists. Use this to scope queries.',
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
    description: 'Return the workspace members. Use to resolve assignees and answer "who is X" - but do not surface named-person breakdowns to the user (use aggregates instead).',
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
];

export const READ_ONLY_TOOL_NAMES = new Set([
  'list_workspaces', 'list_org_structure', 'list_custom_fields',
  'get_team_members', 'query_tasks', 'get_task',
  'aggregate_workload', 'aggregate_throughput',
]);

export const WRITE_TOOL_NAMES = new Set(['create_task', 'update_task', 'add_comment', 'delete_task']);
