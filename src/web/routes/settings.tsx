import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/rpc.js';

export function Settings() {
  const [user, setUser] = useState<{ email: string; name: string | null; isAdmin: boolean } | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [pw, setPw] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [params] = useSearchParams();
  const nav = useNavigate();

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => nav('/login'));
    api.clickupStatus().then((r) => setConnected(r.connected));
  }, [nav]);

  async function setPassword() {
    setPwMsg(null);
    try { await api.setPassword(pw); setPwMsg('Password set.'); setPw(''); }
    catch (e: any) { setPwMsg(String(e.message)); }
  }

  async function logout() { await api.logout(); nav('/login'); }
  async function disconnect() { await api.clickupDisconnect(); setConnected(false); }

  if (!user) return null;
  const cuStatus = params.get('clickup');

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
        <h2 className="font-semibold mb-2">ClickUp connection</h2>
        {cuStatus === 'connected' && <p className="text-sm text-[#34d399] mb-2">Connected ✓</p>}
        {cuStatus === 'error' && <p className="text-sm text-[#f87171] mb-2">Connection failed. Try again.</p>}
        {connected ? (
          <button onClick={disconnect} className="border border-[#f87171] text-[#f87171] rounded-md px-4 py-2 text-sm">Disconnect</button>
        ) : (
          <a href="/api/clickup/connect" className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm">Connect ClickUp</a>
        )}
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
