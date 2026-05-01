import { Link, useParams } from 'react-router-dom';
import type { Conv } from '../../hooks/use-conversations.js';

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

export function ConversationList({ conversations, onNew }: { conversations: Conv[]; onNew: () => void }) {
  const { id: active } = useParams();
  const groups = group(conversations);
  return (
    <aside className="w-[220px] bg-[#0f1117] border-r border-[#2a2f3d] p-3 flex flex-col h-screen overflow-y-auto">
      <button onClick={onNew} className="w-full bg-gradient-to-br from-[#7c6ef7] to-[#5b4fcf] text-white rounded-md py-2 text-sm font-semibold mb-4">+ New conversation</button>
      {Object.entries(groups).map(([label, items]) => items.length > 0 && (
        <div key={label} className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-[#5a6070] font-semibold px-2 mb-1">{label}</div>
          {items.map((c) => (
            <Link key={c.id} to={`/chat/${c.id}`}
              className={`block px-2 py-1.5 rounded-md text-[12px] mb-0.5 truncate ${active === c.id ? 'bg-[#1a1d27] text-[#e8eaf0]' : 'text-[#c9cdd9] hover:bg-[#14161e]'}`}>
              {c.title}
            </Link>
          ))}
        </div>
      ))}
    </aside>
  );
}
