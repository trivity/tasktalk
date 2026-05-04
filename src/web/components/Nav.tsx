import { Link, useLocation, useNavigate } from 'react-router-dom';
import { MessageCircle, Settings as SettingsIcon, Users, LogOut, Repeat } from 'lucide-react';
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

  const link = (to: string, label: string, Icon: typeof MessageCircle) => {
    const active = loc.pathname === to || loc.pathname.startsWith(to + '/');
    return (
      <Link
        to={to}
        className={`px-3 py-1.5 rounded-md text-sm font-medium inline-flex items-center gap-2 transition-colors duration-150 ${
          active
            ? 'bg-surface-active text-text'
            : 'text-text-muted hover:text-text hover:bg-surface-hover'
        }`}
      >
        <Icon className="w-4 h-4" />
        <span>{label}</span>
      </Link>
    );
  };

  return (
    <header className="bg-bg flex items-center justify-between px-5 py-2 flex-shrink-0 border-b border-border">
      <div className="flex items-center gap-1">
        <Link to="/chat" className="font-semibold text-text mr-3 tracking-tight">
          Tasktalk
        </Link>
        {link('/chat', 'Chat', MessageCircle)}
        {link('/routines', 'Routines', Repeat)}
        {link('/settings', 'Settings', SettingsIcon)}
        {user?.isAdmin && link('/members', 'Members', Users)}
      </div>
      <div className="flex items-center gap-3">
        {user && (
          <span className="text-xs text-text-subtle hidden sm:inline">
            {user.email}
            {user.isAdmin && ' · admin'}
          </span>
        )}
        <button
          onClick={logout}
          className="text-xs text-text-muted hover:text-text hover:bg-surface-hover px-2 py-1 rounded-md inline-flex items-center gap-1.5 transition-colors duration-150"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sign out</span>
        </button>
      </div>
    </header>
  );
}
