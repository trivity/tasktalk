import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
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
  connection?: { workspaceId: string } | null;
  workspace?: { lastIncrementalSyncAt?: string | null; syncState?: { phase?: string; listsDone?: number; listsTotal?: number } } | null;
  pending_workspace_id?: boolean;
};

export function Settings() {
  const [user, setUser] = useState<{ email: string; name: string | null; isAdmin: boolean } | null>(null);
  const [cuStatusObj, setCuStatusObj] = useState<ClickUpStatus | null>(null);
  const [pw, setPw] = useState('');
  const [aiCreds, setAiCreds] = useState<AiCredsState | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [params] = useSearchParams();
  const nav = useNavigate();

  const refreshCuStatus = () => api.clickupStatus().then((r) => setCuStatusObj(r as unknown as ClickUpStatus));

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => nav('/login'));
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
    await api.clickupDisconnect();
    void refreshCuStatus();
    toast.success('ClickUp disconnected.');
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

        <section className="space-y-3 pb-8 border-b border-border">
          <h2 className="text-[18px] font-semibold text-text">ClickUp connection</h2>
          {connected ? (
            <>
              {cuStatusObj?.workspace?.lastIncrementalSyncAt ? (
                <p className="text-sm text-text-muted">
                  Last sync: {new Date(cuStatusObj.workspace.lastIncrementalSyncAt).toLocaleString()}
                  {cuStatusObj.workspace.syncState?.phase && cuStatusObj.workspace.syncState.phase !== 'done' && (
                    <span className="ml-2 text-warning">
                      · {cuStatusObj.workspace.syncState.phase} ({cuStatusObj.workspace.syncState.listsDone ?? 0}/{cuStatusObj.workspace.syncState.listsTotal ?? '?'} lists)
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-warning">Never synced — refresh to populate.</p>
              )}
              <div className="flex gap-2 items-center">
                <button
                  onClick={refreshSnapshot}
                  disabled={syncing}
                  className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2 transition-colors duration-150"
                >
                  <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                  <span>{syncing ? 'Refreshing…' : 'Refresh snapshot'}</span>
                </button>
                <button
                  onClick={disconnect}
                  className="text-error hover:bg-error/10 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
                >
                  Disconnect
                </button>
              </div>
              <p className="text-xs text-text-subtle">
                Refresh re-pulls your workspace tree, members, and tasks from ClickUp. Can take a minute or two for large workspaces.
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
