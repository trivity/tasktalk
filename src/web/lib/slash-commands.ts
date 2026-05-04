export type SlashCommand = {
  name: string;
  label: string;
  description: string;
  kind: 'prompt' | 'action';
  prompt?: string;
  action?: 'refresh' | 'help' | 'newRoutine';
};

export const slashCommands: SlashCommand[] = [
  { name: 'help', label: '/help', description: 'List all slash commands', kind: 'action', action: 'help' },
  { name: 'spaces', label: '/spaces', description: 'List spaces in your workspaces', kind: 'prompt', prompt: 'List all spaces across my workspaces.' },
  { name: 'lists', label: '/lists', description: 'List all lists', kind: 'prompt', prompt: 'Show me all lists across my workspaces.' },
  { name: 'team', label: '/team', description: 'Team and current focus', kind: 'prompt', prompt: 'Who is on my team and what is each person working on?' },
  { name: 'mine', label: '/mine', description: 'Your open tasks', kind: 'prompt', prompt: 'Show all my open tasks.' },
  { name: 'overdue', label: '/overdue', description: 'Your overdue tasks', kind: 'prompt', prompt: 'Show me my overdue tasks.' },
  { name: 'today', label: '/today', description: "What's due today", kind: 'prompt', prompt: 'What is due today?' },
  { name: 'week', label: '/week', description: "What's due this week", kind: 'prompt', prompt: 'What is due this week?' },
  { name: 'workload', label: '/workload', description: 'Workload across the team', kind: 'prompt', prompt: 'Give me a workload summary across the team.' },
  { name: 'recent', label: '/recent', description: 'Recently updated tasks', kind: 'prompt', prompt: 'Show me recently updated tasks.' },
  { name: 'find', label: '/find', description: 'Search by task name', kind: 'prompt', prompt: 'Find tasks matching ' },
  { name: 'refresh', label: '/refresh', description: 'Sync ClickUp now', kind: 'action', action: 'refresh' },
  { name: 'routine', label: '/routine', description: 'Create a recurring report', kind: 'action', action: 'newRoutine' },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase().trim();
  if (!q) return slashCommands;
  return slashCommands.filter(
    (c) => c.name.toLowerCase().startsWith(q) || c.description.toLowerCase().includes(q),
  );
}
