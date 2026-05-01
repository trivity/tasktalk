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
