import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/rpc.js';

export function Members() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const nav = useNavigate();

  async function invite() {
    setMsg(null);
    try { await api.invite(email, name || undefined); setMsg('Invite sent.'); setEmail(''); setName(''); }
    catch (e: any) { setMsg(String(e.message)); }
  }

  return (
    <div className="max-w-xl mx-auto p-8">
      <button onClick={() => nav('/settings')} className="text-sm text-[#9298ac] mb-6">← Settings</button>
      <h1 className="text-2xl font-bold mb-6">Members</h1>
      <div className="bg-[#181b22] border border-[#2a2f3d] rounded-xl p-6 space-y-3">
        <input className="w-full bg-[#0f1117] border border-[#2a2f3d] rounded-md p-3" type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full bg-[#0f1117] border border-[#2a2f3d] rounded-md p-3" type="text" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={invite} className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 font-semibold">Send invite</button>
        {msg && <p className="text-sm text-[#9298ac]">{msg}</p>}
      </div>
    </div>
  );
}
