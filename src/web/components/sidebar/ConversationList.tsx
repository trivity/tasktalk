import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import type { Conv } from '../../hooks/use-conversations.js';
import { api } from '../../lib/rpc.js';

function group(convs: Conv[]) {
  const today: Conv[] = [], week: Conv[] = [], earlier: Conv[] = [];
  const now = Date.now();
  for (const c of convs) {
    const age = now - new Date(c.lastMessageAt).getTime();
    if (age < 24 * 3600_000) today.push(c);
    else if (age < 7 * 24 * 3600_000) week.push(c);
    else earlier.push(c);
  }
  return { today, week, earlier };
}

type Props = {
  conversations: Conv[];
  onNew: () => void;
  onChange: () => void;
};

export function ConversationList({ conversations, onNew, onChange }: Props) {
  const { id: active } = useParams();
  const nav = useNavigate();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const groups = group(conversations);

  async function deleteConv(id: string, title: string) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setBusy(id);
    try {
      await api.deleteConversation(id);
      if (active === id) nav('/chat');
      onChange();
    } finally {
      setBusy(null);
    }
  }

  function startRename(id: string, title: string) {
    setRenaming(id);
    setRenameValue(title);
  }

  async function commitRename(id: string) {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed.length > 200) {
      setRenaming(null);
      return;
    }
    setBusy(id);
    try {
      await api.renameConversation(id, trimmed);
      onChange();
    } finally {
      setRenaming(null);
      setBusy(null);
    }
  }

  function row(c: Conv) {
    const isActive = active === c.id;
    const isRenaming = renaming === c.id;
    const isBusy = busy === c.id;

    if (isRenaming) {
      return (
        <div key={c.id} className="px-2 py-1 mb-0.5">
          <input
            autoFocus
            className="w-full bg-bg border border-accent rounded-md text-[13px] px-2 py-1 text-text outline-none"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(c.id);
              if (e.key === 'Escape') setRenaming(null);
            }}
            onBlur={() => void commitRename(c.id)}
            maxLength={200}
          />
        </div>
      );
    }

    return (
      <div
        key={c.id}
        className={`group flex items-center px-2 py-1.5 rounded-md mb-0.5 transition-colors duration-150 ${
          isActive ? 'bg-surface-active text-text' : 'text-text hover:bg-surface-hover'
        } ${isBusy ? 'opacity-50' : ''}`}
      >
        <Link to={`/chat/${c.id}`} className="flex-1 truncate text-[13px]" title={c.title}>
          {c.title}
        </Link>
        <button
          onClick={(e) => {
            e.preventDefault();
            startRename(c.id, c.title);
          }}
          className="opacity-0 group-hover:opacity-100 text-text-subtle hover:text-text px-1 transition-opacity"
          title="Rename"
          aria-label="Rename conversation"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            void deleteConv(c.id, c.title);
          }}
          className="opacity-0 group-hover:opacity-100 text-text-subtle hover:text-error px-1 transition-opacity"
          title="Delete"
          aria-label="Delete conversation"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <aside className="w-[240px] bg-surface p-3 flex flex-col overflow-y-auto">
      <button
        onClick={onNew}
        className="w-full bg-accent hover:bg-accent-hover text-white rounded-md py-2 text-sm font-medium mb-4 flex-shrink-0 inline-flex items-center justify-center gap-2 transition-colors duration-150"
      >
        <Plus className="w-4 h-4" />
        <span>New conversation</span>
      </button>
      {Object.entries(groups).map(([label, items]) => items.length > 0 && (
        <div key={label} className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold px-2 mb-1">
            {label}
          </div>
          {items.map(row)}
        </div>
      ))}
    </aside>
  );
}
