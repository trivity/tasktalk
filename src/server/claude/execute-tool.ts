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
  workspaceIds: string[];
  pool: TurnMcpPool;
}): Promise<ExecuteToolResult> {
  const start = Date.now();
  try {
    let result: unknown;
    let routerPath: 'snapshot' | 'live' | 'snapshot · live-fallback' | 'none' = 'none';

    switch (opts.name) {
      case 'list_workspaces':
        result = await executeListWorkspaces(opts.workspaceIds);
        routerPath = 'snapshot';
        break;
      case 'list_org_structure':
        result = await executeListOrgStructure(opts.workspaceIds);
        routerPath = 'snapshot';
        break;
      case 'list_custom_fields': {
        const a = listCustomFieldsArgs.parse(opts.args);
        result = await executeListCustomFields(opts.workspaceIds, a.scope_id);
        routerPath = 'snapshot';
        break;
      }
      case 'get_team_members':
        result = await executeGetTeamMembers(opts.workspaceIds);
        routerPath = 'snapshot';
        break;
      case 'query_tasks': {
        const a = queryTasksArgs.parse(opts.args);
        const r = await executeQueryTasks(opts.workspaceIds, a, opts.pool);
        result = r;
        routerPath = r.data_source as typeof routerPath;
        break;
      }
      case 'get_task': {
        const a = getTaskArgs.parse(opts.args);
        result = await executeGetTask(opts.workspaceIds, a.task_id, opts.pool);
        routerPath = 'live';
        break;
      }
      case 'aggregate_workload': {
        const a = aggregateWorkloadArgs.parse(opts.args);
        result = await executeAggregateWorkload(opts.workspaceIds, a.group_by);
        routerPath = 'snapshot';
        break;
      }
      case 'aggregate_throughput': {
        const a = aggregateThroughputArgs.parse(opts.args);
        result = await executeAggregateThroughput(opts.workspaceIds, a.since, a.until);
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
