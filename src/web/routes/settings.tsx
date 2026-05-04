import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/rpc.js';
import { ThemeToggle } from '../components/ui/ThemeToggle.js';
import { Nav } from '../components/Nav.js';

type AiCredsState = {
  credentials: Array<{ provider: string; model_preference: string | null; updated_at: string; key_set: boolean }>;
  env_fallback_available: boolean;
  anthropic_models: ReadonlyArray<{ id: string; label: string }>;
  default_model: string;
};

type ClickUpStatus = {
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
};

type AdminSettings = {
  resend_from: string | null;
  resend_api_key_set: boolean;
  routines_per_user_cap: number;
  defaults: { routinesPerUserCap: number };
};

export function Settings() {
  const [user, setUser] = useState<{ email: string; name: string | null; isAdmin: boolean } | null>(null);
  const [cuStatusObj, setCuStatusObj] = useState<ClickUpStatus | null>(null);
  const [pw, setPw] = useState('');
  const [aiCreds, setAiCreds] = useState<AiCredsState | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [adminSettings, setAdminSettings] = useState<AdminSettings | null>(null);
  const [resendKey, setResendKey] = useState('');
  const [resendFrom, setResendFrom] = useState('');
  const [routinesCap, setRoutinesCap] = useState(20);
  const [params] = useSearchParams();
  const nav = useNavigate();

  const refreshCuStatus = () => api.clickupStatus().then((r) => setCuStatusObj(r as unknown as ClickUpStatus));

  const refreshAdmin = () => api.getAdminSettings().then((r) => {
    setAdminSettings(r);
    setResendFrom(r.resend_from ?? '');
    setRoutinesCap(r.routines_per_user_cap);
  }).catch(() => { /* not admin or not configured yet */ });

  useEffect(() => {
    api.me().then((r) => {
      setUser(r.user);
      if (r.user.isAdmin) void refreshAdmin();
    }).catch(() => nav('/login'));
    void refreshCuStatus();
    api.listAiCredentials().then((r) => {
      setAiCreds(r);
      const existing = r.credentials.find((c) => c.provider === 'anthropic');
      setAiModel(existing?.model_preference ?? r.default_model);
    }).catch(() => {});
  }, [nav]);

  useEffect(() => {
    const cuStatus = params.get('clickup');
    if (cuStatus === 'connected') toast.success('ClickUp connected.');
    if (cuStatus === 'error') toast.error('Connection failed. Try again.');
  }, [params]);

  const connected = !!cuStatusObj?.connected;

  async function setPassword() {
    try {
      await api.setPassword(pw);
      toast.success('Password saved.');
      setPw('');
    } catch (e: any) {
      toast.error(String(e.message));
    }
  }

  async function saveAiKey() {
    try {
      await api.setAiCredential('anthropic', aiKey, aiModel || undefined);
      toast.success('API key saved.');
      setAiKey('');
      const r = await api.listAiCredentials();
      setAiCreds(r);
    } catch (e: any) {
      toast.error(String(e.message));
    }
  }

  async function disconnectAi(provider: string) {
    await api.deleteAiCredential(provider);
    const r = await api.listAiCredentials();
    setAiCreds(r);
    setAiModel(r.default_model);
    toast.success('AI provider disconnected.');
  }

  async function disconnect() {
    if (!window.confirm('Disconnect ALL ClickUp workspaces? You can reconnect them later.')) return;
    await api.clickupDisconnect();
    void refreshCuStatus();
    toast.success('All ClickUp workspaces disconnected.');
  }

  async function disconnectWorkspace(workspaceId: string, name: string | null) {
    const label = name && name !== 'Workspace' ? `"${name}"` : `workspace ${workspaceId}`;
    if (!window.confirm(`Disconnect ${label}? Its synced tasks will stop being queryable here. You can reconnect later.`)) return;
    try {
      await api.clickupDisconnectWorkspace(workspaceId);
      toast.success(`Disconnected ${label}.`);
      await refreshCuStatus();
    } catch (e: any) {
      toast.error(`Disconnect failed: ${e?.message ?? 'unknown error'}`);
    }
  }

  async function refreshSnapshot() {
    setSyncing(true);
    try {
      await api.clickupSyncNow();
      toast.success('Snapshot refreshed.');
      await refreshCuStatus();
    } catch (e: any) {
      toast.error(`Refresh failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  }

  async function saveResendKey() {
    if (!resendKey.trim()) return;
    try {
      await api.setResendApiKey(resendKey.trim());
      toast.success('Resend API key saved.');
      setResendKey('');
      await refreshAdmin();
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message ?? 'unknown error'}`);
    }
  }

  async function clearResendKey() {
    if (!window.confirm('Clear the Resend API key? Routines that send email will stop working until a new key is set.')) return;
    try {
      await api.deleteResendApiKey();
      toast.success('Resend API key cleared.');
      await refreshAdmin();
    } catch (e: any) {
      toast.error(`Clear failed: ${e?.message ?? 'unknown error'}`);
    }
  }

  async function saveResendFrom() {
    if (!resendFrom.trim()) return;
    try {
      await api.setResendFrom(resendFrom.trim());
      toast.success('Sender saved.');
      await refreshAdmin();
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message ?? 'unknown error'}`);
    }
  }

  async function saveRoutinesCap() {
    try {
      await api.setRoutinesCap(routinesCap);
      toast.success('Routines-per-user cap saved.');
      await refreshAdmin();
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message ?? 'unknown error'}`);
    }
  }

  if (!user) return null;
  const anthropicCred = aiCreds?.credentials.find((c) => c.provider === 'anthropic');

  return (
    <div className="min-h-screen flex flex-col bg-bg text-text">
      <Nav user={user} />
      <div className="max-w-2xl mx-auto w-full p-10 space-y-12">
        <header>
          <h1 className="text-[32px] font-semibold leading-tight">Settings</h1>
        </header>

        <section className="space-y-3 pb-8 border-b border-border">
          <h2 className="text-[18px] font-semibold text-text">Profile</h2>
          <p className="text-sm text-text-muted">{user.email}{user.isAdmin && ' · admin'}</p>
        </section>

        <section className="space-y-3 pb-8 border-b border-border">
          <h2 className="text-[18px] font-semibold text-text">Set / change password</h2>
          <div className="flex gap-2 items-center">
            <input
              type="password"
              className="bg-surface border border-border rounded-md p-2 text-sm text-text outline-none focus:border-accent transition-colors duration-150"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            <button
              onClick={setPassword}
              className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
            >
              Save
            </button>
          </div>
        </section>

        <section className="space-y-4 pb-8 border-b border-border">
          <h2 className="text-[18px] font-semibold text-text">AI Provider</h2>
          {aiCreds && (
            <p className="text-sm">
              {anthropicCred ? (
                <span className="text-success">Anthropic key set ✓</span>
              ) : aiCreds.env_fallback_available ? (
                <span className="text-text-muted">Using server env key (fallback)</span>
              ) : (
                <span className="text-error">Not configured — chat will not work</span>
              )}
            </p>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-text-muted mb-1.5 font-medium">Provider</label>
              <div className="flex gap-4 items-center">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="ai-provider" checked readOnly />
                  <span>Anthropic</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-text-subtle">
                  <input type="radio" name="ai-provider" disabled />
                  <span>OpenAI <span className="text-xs">(coming soon)</span></span>
                </label>
              </div>
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1.5 font-medium">API key</label>
              <input
                type="password"
                placeholder="sk-ant-..."
                className="bg-surface border border-border rounded-md p-2 w-full text-sm text-text placeholder:text-text-subtle outline-none focus:border-accent transition-colors duration-150"
                value={aiKey}
                onChange={(e) => setAiKey(e.target.value)}
              />
              <details className="mt-2 text-xs text-text-muted">
                <summary className="cursor-pointer hover:text-text select-none transition-colors duration-150">
                  How do I get an Anthropic API key?
                </summary>
                <ol className="mt-2 ml-4 space-y-1 list-decimal">
                  <li>
                    Go to{' '}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline hover:no-underline"
                    >
                      console.anthropic.com/settings/keys
                    </a>
                    {' '}(sign up or sign in if needed).
                  </li>
                  <li>Add a payment method under <strong className="font-semibold">Plans &amp; Billing</strong> → most usage starts at $5 of credits.</li>
                  <li>Click <strong className="font-semibold">Create Key</strong>, name it something like &ldquo;Tasktalk&rdquo;, and copy the key (it starts with <code className="bg-surface px-1 rounded font-mono">sk-ant-</code>).</li>
                  <li>Paste it above and click Save. The key is encrypted before it touches the database; it&rsquo;s never sent back to the browser.</li>
                </ol>
                <p className="mt-2 text-text-subtle">
                  Costs: Sonnet 4.6 is ~$3 per million input tokens, ~$15 per million output. A typical chat turn here is well under 1¢. Set a monthly cap in the Anthropic console if you want a hard ceiling.
                </p>
              </details>
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1.5 font-medium">Model</label>
              <select
                className="bg-surface border border-border rounded-md p-2 w-full text-sm text-text outline-none focus:border-accent transition-colors duration-150"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
              >
                {aiCreds?.anthropic_models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            <div className="flex gap-2 items-center">
              <button
                onClick={saveAiKey}
                disabled={!aiKey}
                className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
              >
                Save
              </button>
              {anthropicCred && (
                <button
                  onClick={() => disconnectAi('anthropic')}
                  className="text-error hover:bg-error/10 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
                >
                  Disconnect
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="space-y-4 pb-8 border-b border-border">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[18px] font-semibold text-text">ClickUp workspaces</h2>
            {connected && (
              <span className="text-xs text-text-subtle">
                {cuStatusObj?.connections.length ?? 0} connected
              </span>
            )}
          </div>
          {connected ? (
            <>
              <ul className="divide-y divide-border border border-border rounded-md overflow-hidden">
                {(cuStatusObj?.connections ?? []).map((conn) => {
                  const inProgress = conn.syncState?.phase && conn.syncState.phase !== 'done';
                  const subline = conn.pending
                    ? 'pending workspace resolution'
                    : inProgress
                      ? `${conn.syncState!.phase} (${conn.syncState!.listsDone ?? 0}/${conn.syncState!.listsTotal ?? '?'} lists)`
                      : conn.lastIncrementalSyncAt
                        ? `Last sync ${new Date(conn.lastIncrementalSyncAt).toLocaleString()}`
                        : 'Never synced';
                  return (
                    <li key={conn.workspaceId} className="px-4 py-3 flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium text-text truncate">{conn.name ?? 'Workspace'}</span>
                          <span className="text-xs text-text-subtle font-mono">id {conn.workspaceId}</span>
                        </div>
                        <div className="text-xs text-text-muted mt-0.5">
                          <span className={inProgress || conn.pending ? 'text-warning' : ''}>{subline}</span>
                          {!conn.pending && (
                            <>
                              <span className="mx-1.5 text-text-subtle">·</span>
                              <span>{conn.spaceCount} {conn.spaceCount === 1 ? 'space' : 'spaces'}</span>
                              <span className="mx-1.5 text-text-subtle">·</span>
                              <span>{conn.taskCount} {conn.taskCount === 1 ? 'task' : 'tasks'}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => disconnectWorkspace(conn.workspaceId, conn.name)}
                        className="text-error hover:bg-error/10 rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 flex-shrink-0"
                      >
                        Disconnect
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex gap-2 items-center flex-wrap">
                <a
                  href="/api/clickup/connect"
                  className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium inline-flex items-center gap-2 transition-colors duration-150"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add another workspace</span>
                </a>
                <button
                  onClick={refreshSnapshot}
                  disabled={syncing}
                  className="bg-surface hover:bg-surface-hover text-text border border-border rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2 transition-colors duration-150"
                >
                  <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                  <span>{syncing ? 'Refreshing…' : 'Refresh all'}</span>
                </button>
                <button
                  onClick={disconnect}
                  className="text-error hover:bg-error/10 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
                >
                  Disconnect all
                </button>
              </div>
              <p className="text-xs text-text-subtle">
                Click <strong>Add another workspace</strong> to authorize a workspace ClickUp didn't include in your original grant — on the ClickUp approval screen, tick the workspace(s) you want to add. Existing connections stay intact.
              </p>
            </>
          ) : (
            <a
              href="/api/clickup/connect"
              className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium inline-block transition-colors duration-150"
            >
              Connect ClickUp
            </a>
          )}
        </section>

        <section className="space-y-3 pb-8 border-b border-border">
          <h2 className="text-[18px] font-semibold text-text">Appearance</h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-text-muted">Theme</span>
            <ThemeToggle />
          </div>
        </section>

        {user.isAdmin && (
          <section className="space-y-4 pb-8 border-b border-border">
            <h2 className="text-[18px] font-semibold text-text">Admin · Email delivery (Resend)</h2>
            <p className="text-sm text-text-muted">
              Used by routines to deliver reports via email. Visible only to admins.
            </p>

            <div>
              <label className="block text-xs text-text-muted mb-1.5 font-medium">Resend API key</label>
              <div className="flex gap-2 items-center">
                <input
                  type="password"
                  placeholder={adminSettings?.resend_api_key_set ? '•••••••• (set — re-enter to replace)' : 're_...'}
                  className="bg-surface border border-border rounded-md p-2 flex-1 text-sm text-text placeholder:text-text-subtle outline-none focus:border-accent transition-colors duration-150"
                  value={resendKey}
                  onChange={(e) => setResendKey(e.target.value)}
                />
                <button
                  onClick={saveResendKey}
                  disabled={!resendKey}
                  className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  Save
                </button>
                {adminSettings?.resend_api_key_set && (
                  <button
                    onClick={clearResendKey}
                    className="text-error hover:bg-error/10 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-text-subtle mt-1">
                Get one at{' '}
                <a href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-accent underline hover:no-underline">resend.com/api-keys</a>.
                Stored encrypted at rest.
              </p>
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1.5 font-medium">From address</label>
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  placeholder="Tasktalk <noreply@yourdomain.com>"
                  className="bg-surface border border-border rounded-md p-2 flex-1 text-sm text-text placeholder:text-text-subtle outline-none focus:border-accent transition-colors duration-150"
                  value={resendFrom}
                  onChange={(e) => setResendFrom(e.target.value)}
                />
                <button
                  onClick={saveResendFrom}
                  disabled={!resendFrom.trim()}
                  className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  Save
                </button>
              </div>
              <p className="text-xs text-text-subtle mt-1">
                The sender domain must be verified in Resend. Format: <code className="bg-surface px-1 rounded font-mono">Display Name &lt;email@domain&gt;</code>.
              </p>
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1.5 font-medium">Routines per user (cap)</label>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  min={1}
                  max={1000}
                  className="bg-surface border border-border rounded-md p-2 w-24 text-sm text-text outline-none focus:border-accent transition-colors duration-150"
                  value={routinesCap}
                  onChange={(e) => setRoutinesCap(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
                />
                <button
                  onClick={saveRoutinesCap}
                  className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
                >
                  Save
                </button>
                <span className="text-xs text-text-subtle">default {adminSettings?.defaults.routinesPerUserCap ?? 20}</span>
              </div>
            </div>
          </section>
        )}

        {user.isAdmin && (
          <section className="space-y-3 pb-8 last:border-0">
            <h2 className="text-[18px] font-semibold text-text">Members</h2>
            <Link to="/members" className="text-sm text-accent underline hover:no-underline">
              Manage members →
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}
