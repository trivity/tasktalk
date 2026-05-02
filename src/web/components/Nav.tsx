import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/rpc.js';

type Props = {
  user: { email: string; name: string | null; isAdmin: boolean } | null;
};

export function Nav({ user }: Props) {
  const loc = useLocation();
  const nav = useNavigate();

  async function logout() {
    await api.logout();
    nav('/login');
  }

  const link = (to: string, label: string) => {
    const active = loc.pathname === to || loc.pathname.startsWith(to + '/');
    return (
      <Link
        to={to}
        className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
          active
            ? 'bg-[#1a1d27] text-[#e8eaf0]'
            : 'text-[#9298ac] hover:text-[#e8eaf0] hover:bg-[#14161e]'
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <header className="border-b border-[#2a2f3d] bg-[#0f1117] flex items-center justify-between px-5 py-2 flex-shrink-0">
      <div className="flex items-center gap-1">
        <Link to="/chat" className="font-bold text-[#e8eaf0] mr-3 tracking-tight">
          Tasktalk
        </Link>
        {link('/chat', 'Chat')}
        {link('/settings', 'Settings')}
        {user?.isAdmin && link('/members', 'Members')}
      </div>
      <div className="flex items-center gap-3">
        {user && (
          <span className="text-xs text-[#5a6070] hidden sm:inline">
            {user.email}
            {user.isAdmin && ' · admin'}
          </span>
        )}
        <button onClick={logout} className="text-xs text-[#9298ac] hover:text-[#f87171] px-2 py-1">
          Sign out
        </button>
      </div>
    </header>
  );
}
