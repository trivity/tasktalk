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
