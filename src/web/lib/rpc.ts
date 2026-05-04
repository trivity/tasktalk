async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: 'include' });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  me: () => request<{ user: { id: string; email: string; name: string | null; isAdmin: boolean } }>('/api/auth/me'),
  loginMagicLink: (email: string) => request<{ ok: true }>('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'magic_link', email }),
  }),
  loginPassword: (email: string, password: string) => request<{ ok: true }>('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'password', email, password }),
  }),
  loginCallback: (token: string) => request<{ ok: true }>('/api/auth/login/callback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  setPassword: (password: string) => request<{ ok: true }>('/api/auth/me/password', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  }),
  invite: (email: string, name?: string) => request<{ ok: true }>('/api/auth/members/invite', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name }),
  }),
  clickupStatus: () => request<{
    connected: boolean;
    connections: Array<{
      workspaceId: string;
      name: string | null;
      pending: boolean;
      lastFullSyncAt: string | null;
      lastIncrementalSyncAt: string | null;
      syncState: { phase?: string; listsDone?: number; listsTotal?: number } | null;
      taskCount: number;
      spaceCount: number;
    }>;
  }>('/api/clickup/status'),
  clickupDisconnect: () => request<{ ok: true }>('/api/clickup/disconnect', { method: 'POST' }),
  clickupDisconnectWorkspace: (workspaceId: string) =>
    request<{ ok: true }>(`/api/clickup/connections/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }),
  clickupSyncNow: () => request<{ ok: true }>('/api/clickup/sync-now', { method: 'POST' }),
  listConversations: () => request<{ conversations: Array<{ id: string; title: string; lastMessageAt: string }> }>('/api/conversations'),
  createConversation: () => request<{ conversation: { id: string; title: string } }>('/api/conversations', { method: 'POST' }),
  listMessages: (id: string) => request<{ messages: Array<{ id: string; role: string; content: any; createdAt: string }> }>(`/api/conversations/${id}/messages`),
  deleteConversation: (id: string) => request<{ ok: true }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  renameConversation: (id: string, title: string) => request<{ ok: true }>(`/api/conversations/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }),
  confirmWrite: (token: string, confirm: boolean) => fetch('/api/confirm-write', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ confirmation_token: token, confirm }),
  }),
  undoLast: (conversationId: string) => fetch(`/api/undo/${conversationId}`, {
    method: 'POST', credentials: 'include',
    headers: { accept: 'text/event-stream' },
  }),
  estimateWorkspace: () => request<{ approxTaskCount: number; listCount: number }>('/api/onboarding/estimate'),
  syncProgress: () => request<{
    status: 'pending' | 'running' | 'done';
    syncState?: { phase?: string; listsDone?: number; listsTotal?: number };
    workspace?: { id: string; name: string };
  }>('/api/onboarding/sync-progress'),
  listAiCredentials: () => request<{
    credentials: Array<{ provider: string; model_preference: string | null; updated_at: string; key_set: boolean }>;
    env_fallback_available: boolean;
    anthropic_models: ReadonlyArray<{ id: string; label: string }>;
    default_model: string;
  }>('/api/auth/me/ai-credentials'),
  setAiCredential: (provider: string, api_key: string, model_preference?: string) => request<{ ok: true }>('/api/auth/me/ai-credentials', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, api_key, model_preference }),
  }),
  deleteAiCredential: (provider: string) => request<{ ok: true }>(`/api/auth/me/ai-credentials/${provider}`, { method: 'DELETE' }),

  // Admin settings (admin-only)
  getAdminSettings: () => request<{
    resend_from: string | null;
    resend_api_key_set: boolean;
    routines_per_user_cap: number;
    defaults: { routinesPerUserCap: number };
  }>('/api/admin/settings'),
  setResendApiKey: (value: string) => request<{ ok: true }>('/api/admin/settings/resend-api-key', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }),
  }),
  deleteResendApiKey: () => request<{ ok: true }>('/api/admin/settings/resend-api-key', { method: 'DELETE' }),
  setResendFrom: (value: string) => request<{ ok: true }>('/api/admin/settings/resend-from', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }),
  }),
  setRoutinesCap: (value: number) => request<{ ok: true }>('/api/admin/settings/routines-cap', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }),
  }),

  // Routines
  listRoutines: () => request<{
    routines: Array<{
      id: string;
      name: string;
      prompt: string;
      schedule: RoutineSchedule;
      scheduleDescription: string;
      timezone: string;
      deliverChat: boolean;
      deliverEmail: boolean;
      emailTo: string | null;
      enabled: boolean;
      conversationId: string;
      lastRunAt: string | null;
      nextRunAt: string;
      lastRun: { status: 'running' | 'done' | 'error'; startedAt: string; finishedAt: string | null; errorMessage: string | null } | null;
    }>;
  }>('/api/routines'),
  createRoutine: (body: {
    name: string;
    prompt: string;
    schedule: RoutineSchedule;
    timezone: string;
    deliverChat: boolean;
    deliverEmail: boolean;
    emailTo: string | null;
    enabled: boolean;
  }) => request<{ routine: { id: string } }>('/api/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  updateRoutine: (id: string, body: Partial<{
    name: string;
    prompt: string;
    schedule: RoutineSchedule;
    timezone: string;
    deliverChat: boolean;
    deliverEmail: boolean;
    emailTo: string | null;
    enabled: boolean;
  }>) => request<{ ok: true }>(`/api/routines/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  deleteRoutine: (id: string) => request<{ ok: true }>(`/api/routines/${id}`, { method: 'DELETE' }),
  runRoutineNow: (id: string) => request<{ ok: true }>(`/api/routines/${id}/run-now`, { method: 'POST' }),
};

export type RoutineSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'monthly'; dayOfMonth: number; time: string };
