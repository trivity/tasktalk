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
    <div className="min-h-screen flex items-center justify-center bg-bg p-6">
      <form
        onSubmit={submit}
        className="bg-surface rounded-lg p-10 w-[420px] shadow-lg shadow-black/5"
      >
        <h1 className="text-[24px] font-semibold mb-1 text-text">Sign in to Tasktalk</h1>
        <p className="text-sm text-text-muted mb-8">Talk to your ClickUp workspace through Claude.</p>
        <input
          className="w-full bg-bg border border-border rounded-md p-3 mb-3 text-text placeholder:text-text-subtle outline-none focus:border-accent transition-colors duration-150"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {usePw && (
          <input
            className="w-full bg-bg border border-border rounded-md p-3 mb-3 text-text placeholder:text-text-subtle outline-none focus:border-accent transition-colors duration-150"
            type="password"
            placeholder="Password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        )}
        <button
          className="w-full bg-accent hover:bg-accent-hover text-white rounded-md p-3 font-medium mb-2 transition-colors duration-150"
          type="submit"
        >
          {usePw ? 'Sign in' : 'Send magic link'}
        </button>
        <button
          type="button"
          onClick={() => setUsePw(!usePw)}
          className="w-full text-sm text-text-muted hover:text-text py-2 transition-colors duration-150"
        >
          {usePw ? 'Use magic link instead' : 'Use password instead'}
        </button>
        {msg && <p className="text-sm text-text-muted mt-3 text-center">{msg}</p>}
      </form>
    </div>
  );
}
