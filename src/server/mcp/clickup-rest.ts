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
