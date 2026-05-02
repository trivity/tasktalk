import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/rpc.js';
import { useConversations } from '../hooks/use-conversations.js';
import { useMessageStream } from '../hooks/use-message-stream.js';
import { useTaskContext } from '../hooks/use-task-context.js';
import { ConversationList } from '../components/sidebar/ConversationList.js';
import { TaskContextPanel } from '../components/sidebar/TaskContextPanel.js';
import { MessageStream } from '../components/chat/MessageStream.js';
import { Composer } from '../components/chat/Composer.js';
import { Nav } from '../components/Nav.js';

type PersistedMessage = { id: string; role: string; content: any; createdAt: string };
type CurrentUser = { id: string; email: string; name: string | null; isAdmin: boolean };

const SUGGESTED_PROMPTS = [
  'What should I work on next?',
  'Show me overdue tasks',
  "Who's overloaded?",
  'What did the team ship last week?',
];

export function Chat() {
  const { id } = useParams();
  const nav = useNavigate();
  const { conversations, refresh: refreshConvs } = useConversations();
  const [history, setHistory] = useState<PersistedMessage[]>([]);
  const { streaming, send } = useMessageStream(id ?? '');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => localStorage.getItem('tt_sidebar') !== 'closed');
  const [rightOpen, setRightOpen] = useState<boolean>(() => localStorage.getItem('tt_right') === 'open');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const tasks = useTaskContext(history);

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => nav('/login'));
  }, [nav]);

  useEffect(() => {
    localStorage.setItem('tt_sidebar', sidebarOpen ? 'open' : 'closed');
  }, [sidebarOpen]);

  useEffect(() => {
    localStorage.setItem('tt_right', rightOpen ? 'open' : 'closed');
  }, [rightOpen]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const apply = () => { if (mq.matches) setRightOpen(false); };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const loadHistory = useCallback(async () => {
    if (!id) return;
    const r = await api.listMessages(id);
    setHistory(r.messages);
  }, [id]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/conversations/${id}/events`, { withCredentials: true } as any);
    es.addEventListener('system_event', () => { void loadHistory(); });
    return () => es.close();
  }, [id, loadHistory]);

  async function newConv() {
    const r = await api.createConversation();
    await refreshConvs();
    nav(`/chat/${r.conversation.id}`);
  }

  async function onSend(text: string) {
    setHistory((h) => [...h, { id: `optimistic-${Date.now()}`, role: 'user', content: { text }, createdAt: new Date().toISOString() }]);
    await send(text, () => { void loadHistory(); void refreshConvs(); });
  }

  const onConfirmResolved = useCallback(() => {
    void loadHistory();
    void refreshConvs();
  }, [loadHistory, refreshConvs]);

  return (
    <div className="flex flex-col h-screen bg-[#0a0b0f] text-[#e8eaf0]">
      <Nav user={user} />
      <div className="flex flex-1 overflow-hidden">
      {sidebarOpen && <ConversationList conversations={conversations} onNew={newConv} onChange={refreshConvs} />}
      <main className="flex-1 flex flex-col">
        {!id ? (
          <>
            <header className="border-b border-[#2a2f3d] px-6 py-3 flex justify-end items-center gap-2">
              <button
                onClick={() => setRightOpen((v) => !v)}
                className="text-[#9298ac] text-sm ml-2"
              >
                {rightOpen ? 'Hide context' : 'Show context'}
              </button>
              <button
                onClick={() => setSidebarOpen((v) => !v)}
                className="text-[#9298ac] text-sm"
                aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              >
                {sidebarOpen ? '▶' : '◀'}
              </button>
            </header>
            <div className="flex-1 flex items-center justify-center text-[#9298ac]">
              <div className="text-center">
                <p className="mb-4">No conversation selected</p>
                <button onClick={newConv} className="bg-[#7c6ef7] text-white rounded-md px-4 py-2 text-sm">Start a new one</button>
              </div>
            </div>
          </>
        ) : (
          <>
            <header className="border-b border-[#2a2f3d] px-6 py-3 text-sm text-[#9298ac] flex justify-between items-center">
              <span>{conversations.find((c) => c.id === id)?.title ?? 'Conversation'}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setRightOpen((v) => !v)}
                  className="text-[#9298ac] text-sm ml-2"
                >
                  {rightOpen ? 'Hide context' : 'Show context'}
                </button>
                <button
                  onClick={() => setSidebarOpen((v) => !v)}
                  className="text-[#9298ac] text-sm"
                  aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                >
                  {sidebarOpen ? '▶' : '◀'}
                </button>
              </div>
            </header>
            {!streaming && history.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md">
                  <p className="text-[#9298ac] text-sm mb-4">Try asking</p>
                  <div className="grid grid-cols-1 gap-2">
                    {SUGGESTED_PROMPTS.map((s) => (
                      <button
                        key={s}
                        onClick={() => onSend(s)}
                        className="text-left bg-[#181b22] border border-[#2a2f3d] rounded-md p-3 text-sm text-[#c9cdd9] hover:border-[#7c6ef7]"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <MessageStream history={history} streaming={streaming} onConfirmResolved={onConfirmResolved} />
            )}
            <Composer disabled={!!streaming && !streaming.done} onSend={onSend} />
          </>
        )}
      </main>
      {rightOpen && <TaskContextPanel tasks={tasks} asOf={null} />}
      </div>
    </div>
  );
}
