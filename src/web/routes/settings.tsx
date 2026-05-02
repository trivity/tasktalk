import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [aiCreds, setAiCreds] = useState<AiCredsState | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
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

  const connected = !!cuStatusObj?.connected;

  async function setPassword() {
    setPwMsg(null);
    try { await api.setPassword(pw); setPwMsg('Password set.'); setPw(''); }
    catch (e: any) { setPwMsg(String(e.message)); }
  }

  async function saveAiKey() {
    setAiMsg(null);
    try {
      await api.setAiCredential('anthropic', aiKey, aiModel || undefined);
      setAiMsg('Saved.');
      setAiKey('');
      const r = await api.listAiCredentials();
      setAiCreds(r);
    } catch (e: any) { setAiMsg(String(e.message)); }
  }

  async function disconnectAi(provider: string) {
    await api.deleteAiCredential(provider);
    const r = await api.listAiCredentials();
    setAiCreds(r);
    setAiModel(r.default_model);
  }

  async function logout() { await api.logout(); nav('/login'); }
  async function disconnect() { await api.clickupDisconnect(); void refreshCuStatus(); }
  async function refreshSnapshot() {
    setSyncMsg(null);
    setSyncing(true);
    try {
      await api.clickupSyncNow();
      setSyncMsg('Snapshot refreshed.');
      await refreshCuStatus();
    } catch (e: any) {
      setSyncMsg(`Refresh failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  }

  if (!user) return null;
  const cuStatus = params.get('clickup');
  const anthropicCred = aiCreds?.credentials.find((c) => c.provider === 'anthropic');

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0b0f] text-[#e8eaf0]">
      <Nav user={user} />
      <div className="max-w-2xl mx-auto w-full p-8 space-y-8">
      <header className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Settings</h1>
      </header>

      <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
        <h2 className="font-semibold mb-2">Profile</h2>
        <p className="text-sm text-[#9298ac]">{user.email}{user.isAdmin && ' · admin'}</p>
      </section>

      <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
        <h2 className="font-semibold mb-2">Set / change password</h2>
        <input type="password" className="bg-[#0f1117] border border-[#2a2f3d] rounded-md p-2 mr-2" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button onClick={setPassword} className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm">Save</button>
        {pwMsg && <p className="text-sm text-[#9298ac] mt-2">{pwMsg}</p>}
      </section>

      <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
        <h2 className="font-semibold mb-2">AI Provider</h2>
        {aiCreds && (
          <p className="text-sm mb-3">
            {anthropicCred ? (
              <span className="text-[#34d399]">Anthropic key set ✓</span>
            ) : aiCreds.env_fallback_available ? (
              <span className="text-[#9298ac]">Using server env key (fallback)</span>
            ) : (
              <span className="text-[#f87171]">Not configured — chat will not work</span>
            )}
          </p>
        )}

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-[#9298ac] mb-1">Provider</label>
            <div className="flex gap-3 items-center">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="ai-provider" checked readOnly />
                <span>Anthropic</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-[#5a6071]">
                <input type="radio" name="ai-provider" disabled />
                <span>OpenAI <span className="text-xs">(coming soon)</span></span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs text-[#9298ac] mb-1">API key</label>
            <input
              type="password"
              placeholder="sk-ant-..."
              className="bg-[#0f1117] border border-[#2a2f3d] rounded-md p-2 w-full text-sm"
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
            />
            <details className="mt-2 text-xs text-[#9298ac]">
              <summary className="cursor-pointer hover:text-[#c9cdd9] select-none">
                How do I get an Anthropic API key?
              </summary>
              <ol className="mt-2 ml-4 space-y-1 list-decimal">
                <li>
                  Go to{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#7c6ef7] underline"
                  >
                    console.anthropic.com/settings/keys
                  </a>
                  {' '}(sign up or sign in if needed).
                </li>
                <li>Add a payment method under <strong>Plans &amp; Billing</strong> → most usage starts at $5 of credits.</li>
                <li>Click <strong>Create Key</strong>, name it something like &ldquo;Tasktalk&rdquo;, and copy the key (it starts with <code className="bg-[#0f1117] px-1 rounded">sk-ant-</code>).</li>
                <li>Paste it above and click Save. The key is encrypted before it touches the database; it&rsquo;s never sent back to the browser.</li>
              </ol>
              <p className="mt-2 text-[#5a6070]">
                Costs: Sonnet 4.6 is ~$3 per million input tokens, ~$15 per million output. A typical chat turn here is well under 1¢. Set a monthly cap in the Anthropic console if you want a hard ceiling.
              </p>
            </details>
          </div>

          <div>
            <label className="block text-xs text-[#9298ac] mb-1">Model</label>
            <select
              className="bg-[#0f1117] border border-[#2a2f3d] rounded-md p-2 w-full text-sm"
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
              className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
            {anthropicCred && (
              <button
                onClick={() => disconnectAi('anthropic')}
                className="border border-[#f87171] text-[#f87171] rounded-md px-4 py-2 text-sm"
              >
                Disconnect
              </button>
            )}
          </div>
          {aiMsg && <p className="text-sm text-[#9298ac]">{aiMsg}</p>}
        </div>
      </section>

      <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
        <h2 className="font-semibold mb-2">ClickUp connection</h2>
        {cuStatus === 'connected' && <p className="text-sm text-[#34d399] mb-2">Connected ✓</p>}
        {cuStatus === 'error' && <p className="text-sm text-[#f87171] mb-2">Connection failed. Try again.</p>}
        {connected ? (
          <>
            {cuStatusObj?.workspace?.lastIncrementalSyncAt ? (
              <p className="text-xs text-[#9298ac] mb-3">
                Last sync: {new Date(cuStatusObj.workspace.lastIncrementalSyncAt).toLocaleString()}
                {cuStatusObj.workspace.syncState?.phase && cuStatusObj.workspace.syncState.phase !== 'done' && (
                  <span className="ml-2 text-[#fbbf24]">
                    · {cuStatusObj.workspace.syncState.phase} ({cuStatusObj.workspace.syncState.listsDone ?? 0}/{cuStatusObj.workspace.syncState.listsTotal ?? '?'} lists)
                  </span>
                )}
              </p>
            ) : (
              <p className="text-xs text-[#fbbf24] mb-3">Never synced — refresh to populate.</p>
            )}
            <div className="flex gap-2 items-center">
              <button
                onClick={refreshSnapshot}
                disabled={syncing}
                className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {syncing ? 'Refreshing…' : 'Refresh snapshot'}
              </button>
              <button onClick={disconnect} className="border border-[#f87171] text-[#f87171] rounded-md px-4 py-2 text-sm">Disconnect</button>
            </div>
            {syncMsg && <p className="text-sm text-[#9298ac] mt-2">{syncMsg}</p>}
            <p className="text-xs text-[#5a6070] mt-3">
              Refresh re-pulls your workspace tree, members, and tasks from ClickUp. Can take a minute or two for large workspaces.
            </p>
          </>
        ) : (
          <a href="/api/clickup/connect" className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm">Connect ClickUp</a>
        )}
      </section>

      <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
        <h2 className="font-semibold mb-2">Appearance</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#9298ac]">Theme</span>
          <ThemeToggle />
        </div>
      </section>

      {user.isAdmin && (
        <section className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6">
          <h2 className="font-semibold mb-2">Members</h2>
          <Link to="/members" className="text-sm text-[#7c6ef7]">Manage members →</Link>
        </section>
      )}
      </div>
    </div>
  );
}
