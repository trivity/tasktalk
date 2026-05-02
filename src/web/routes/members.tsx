import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/rpc.js';
import { Nav } from '../components/Nav.js';

type CurrentUser = { id: string; email: string; name: string | null; isAdmin: boolean };

export function Members() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => nav('/login'));
  }, [nav]);

  async function invite() {
    try {
      await api.invite(email, name || undefined);
      toast.success('Invite sent.');
      setEmail('');
      setName('');
    } catch (e: any) {
      toast.error(String(e.message));
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-bg text-text">
      <Nav user={user} />
      <div className="max-w-xl mx-auto w-full p-10 space-y-8">
        <h1 className="text-[32px] font-semibold leading-tight">Members</h1>
        <section className="space-y-3">
          <h2 className="text-[18px] font-semibold text-text">Invite a member</h2>
          <input
            className="w-full bg-surface border border-border rounded-md p-3 text-sm text-text placeholder:text-text-subtle outline-none focus:border-accent transition-colors duration-150"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="w-full bg-surface border border-border rounded-md p-3 text-sm text-text placeholder:text-text-subtle outline-none focus:border-accent transition-colors duration-150"
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            onClick={invite}
            className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium inline-flex items-center gap-2 transition-colors duration-150"
          >
            <UserPlus className="w-4 h-4" />
            <span>Send invite</span>
          </button>
        </section>
      </div>
    </div>
  );
}
