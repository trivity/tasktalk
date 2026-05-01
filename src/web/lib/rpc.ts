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
  clickupStatus: () => request<{ connected: boolean }>('/api/clickup/status'),
  clickupDisconnect: () => request<{ ok: true }>('/api/clickup/disconnect', { method: 'POST' }),
};
