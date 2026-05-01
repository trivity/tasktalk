import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/rpc.js';

export function Login() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [usePw, setUsePw] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    const token = params.get('token');
    if (token) {
      api.loginCallback(token).then(() => nav('/settings')).catch((e) => setMsg(String(e.message)));
    }
  }, [params, nav]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      if (usePw) { await api.loginPassword(email, pw); nav('/settings'); }
      else { await api.loginMagicLink(email); setMsg('Check your email for a sign-in link.'); }
    } catch (err: any) { setMsg(String(err.message)); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={submit} className="bg-[#181b22] border border-[#2a2f3d] rounded-2xl p-8 w-[400px]">
        <h1 className="text-xl font-bold mb-6">Sign in to Tasktalk</h1>
        <input className="w-full bg-[#0f1117] border border-[#2a2f3d] rounded-md p-3 mb-3" type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        {usePw && (
          <input className="w-full bg-[#0f1117] border border-[#2a2f3d] rounded-md p-3 mb-3" type="password" placeholder="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        )}
        <button className="w-full bg-[#7c6ef7] text-white rounded-md p-3 font-semibold mb-2" type="submit">
          {usePw ? 'Sign in' : 'Send magic link'}
        </button>
        <button type="button" onClick={() => setUsePw(!usePw)} className="w-full text-sm text-[#9298ac] py-2">
          {usePw ? 'Use magic link instead' : 'Use password instead'}
        </button>
        {msg && <p className="text-sm text-[#9298ac] mt-3">{msg}</p>}
      </form>
    </div>
  );
}
