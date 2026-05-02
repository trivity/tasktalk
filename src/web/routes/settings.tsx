import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/rpc.js';
import { ThemeToggle } from '../components/ui/ThemeToggle.js';

type AiCredsState = {
  credentials: Array<{ provider: string; model_preference: string | null; updated_at: string; key_set: boolean }>;
  env_fallback_available: boolean;
  anthropic_models: ReadonlyArray<{ id: string; label: string }>;
  default_model: string;
};

export function Settings() {
  const [user, setUser] = useState<{ email: string; name: string | null; isAdmin: boolean } | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [pw, setPw] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [aiCreds, setAiCreds] = useState<AiCredsState | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [params] = useSearchParams();
  const nav = useNavigate();

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => nav('/login'));
    api.clickupStatus().then((r) => setConnected(r.connected));
    api.listAiCredentials().then((r) => {
      setAiCreds(r);
      const existing = r.credentials.find((c) => c.provider === 'anthropic');
      setAiModel(existing?.model_preference ?? r.default_model);
    }).catch(() => {});
  }, [nav]);

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
  async function disconnect() { await api.clickupDisconnect(); setConnected(false); }

  if (!user) return null;
  const cuStatus = params.get('clickup');
  const anthropicCred = aiCreds?.credentials.find((c) => c.provider === 'anthropic');

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-8">
      <header className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Settings</h1>
        <button onClick={logout} className="text-sm text-[#9298ac]">Sign out</button>
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
          <button onClick={disconnect} className="border border-[#f87171] text-[#f87171] rounded-md px-4 py-2 text-sm">Disconnect</button>
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
  );
}
