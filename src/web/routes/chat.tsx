import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/rpc.js';
import { useConversations } from '../hooks/use-conversations.js';
import { useMessageStream } from '../hooks/use-message-stream.js';
import { ConversationList } from '../components/sidebar/ConversationList.js';
import { MessageStream } from '../components/chat/MessageStream.js';
import { Composer } from '../components/chat/Composer.js';

type PersistedMessage = { id: string; role: string; content: any; createdAt: string };

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

  useEffect(() => {
    localStorage.setItem('tt_sidebar', sidebarOpen ? 'open' : 'closed');
  }, [sidebarOpen]);

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
    <div className="flex h-screen bg-[#0a0b0f] text-[#e8eaf0]">
      {sidebarOpen && <ConversationList conversations={conversations} onNew={newConv} />}
      <main className="flex-1 flex flex-col">
        {!id ? (
          <>
            <header className="border-b border-[#2a2f3d] px-6 py-3 flex justify-end">
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
              <button
                onClick={() => setSidebarOpen((v) => !v)}
                className="text-[#9298ac] text-sm"
                aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              >
                {sidebarOpen ? '▶' : '◀'}
              </button>
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
    </div>
  );
}
