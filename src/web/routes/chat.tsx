import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PanelLeft, PanelRight, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/rpc.js';
import { slashCommands, filterSlashCommands, type SlashCommand } from '../lib/slash-commands.js';
import { useConversations } from '../hooks/use-conversations.js';
import { useMessageStream } from '../hooks/use-message-stream.js';
import { useTaskContext } from '../hooks/use-task-context.js';
import { ConversationList } from '../components/sidebar/ConversationList.js';
import { TaskContextPanel } from '../components/sidebar/TaskContextPanel.js';
import { MessageStream } from '../components/chat/MessageStream.js';
import { Composer } from '../components/chat/Composer.js';
import { SlashMenu } from '../components/chat/SlashMenu.js';
import { Nav } from '../components/Nav.js';

type PersistedMessage = { id: string; role: string; content: any; createdAt: string };
type CurrentUser = { id: string; email: string; name: string | null; isAdmin: boolean };

const SUGGESTED_PROMPTS = [
  'What should I work on next?',
  'Show me overdue tasks',
  "Who's overloaded?",
  'What did the team ship last week?',
];

const DEFAULT_TITLE = 'New conversation';

function makeAutoTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 60) return cleaned;
  return cleaned.slice(0, 60).trimEnd();
}

export function Chat() {
  const { id } = useParams();
  const nav = useNavigate();
  const { conversations, refresh: refreshConvs } = useConversations();
  const [history, setHistory] = useState<PersistedMessage[]>([]);
  const { streaming, send } = useMessageStream(id ?? '');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => localStorage.getItem('tt_sidebar') !== 'closed');
  const [rightOpen, setRightOpen] = useState<boolean>(() => localStorage.getItem('tt_right') === 'open');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const tasks = useTaskContext(history);
  const currentTitle = conversations.find((c) => c.id === id)?.title ?? 'Conversation';

  function startRename() {
    setTitleDraft(currentTitle);
    setRenamingTitle(true);
  }

  async function commitRename() {
    const trimmed = titleDraft.trim();
    if (!id || !trimmed || trimmed.length > 200 || trimmed === currentTitle) {
      setRenamingTitle(false);
      return;
    }
    try {
      await api.renameConversation(id, trimmed);
      await refreshConvs();
    } finally {
      setRenamingTitle(false);
    }
  }

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
    if (!id) return;
    const isFirstMessage = history.length === 0;
    setHistory((h) => [...h, { id: `optimistic-${Date.now()}`, role: 'user', content: { text }, createdAt: new Date().toISOString() }]);
    await send(text, async () => {
      void loadHistory();
      // Auto-title on first message, only if title is still default
      if (isFirstMessage) {
        const conv = conversations.find((c) => c.id === id);
        const title = conv?.title ?? DEFAULT_TITLE;
        if (title === DEFAULT_TITLE) {
          try {
            await api.renameConversation(id, makeAutoTitle(text));
          } catch {
            // Best-effort; ignore
          }
        }
      }
      void refreshConvs();
    });
  }

  const onConfirmResolved = useCallback(() => {
    void loadHistory();
    void refreshConvs();
  }, [loadHistory, refreshConvs]);

  const onSendSuggestion = useCallback((text: string) => {
    void onSend(text);
  }, [id, history.length, conversations]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCommandAction = useCallback(async (action: 'refresh' | 'help') => {
    if (action === 'refresh') {
      try {
        await api.clickupSyncNow();
        toast.success('Sync started. Snapshot will refresh shortly.');
      } catch (e: any) {
        toast.error(`Sync failed: ${e?.message ?? 'unknown error'}`);
      }
      return;
    }
    if (action === 'help') {
      const lines = slashCommands.map((c) => `${c.label}  ${c.description}`).join('\n');
      toast(`Slash commands:\n${lines}`, { duration: 10000 });
    }
  }, []);

  const [composerText, setComposerText] = useState('');
  const [slashHighlight, setSlashHighlight] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const slashMatch = composerText.match(/^\/(\S*)$/);
  const slashFiltered = slashMatch ? filterSlashCommands(slashMatch[1] ?? '') : [];
  const slashActive = !!slashMatch && slashFiltered.length > 0;

  useEffect(() => {
    if (slashHighlight >= slashFiltered.length) setSlashHighlight(0);
  }, [slashFiltered.length, slashHighlight]);

  const selectCommand = useCallback((cmd: SlashCommand) => {
    if (cmd.kind === 'action') {
      void onCommandAction(cmd.action!);
      setComposerText('');
      setSlashHighlight(0);
      setTimeout(() => composerRef.current?.focus(), 0);
      return;
    }
    const next = cmd.prompt ?? '';
    setComposerText(next);
    setSlashHighlight(0);
    setTimeout(() => {
      const ta = composerRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(next.length, next.length);
      }
    }, 0);
  }, [onCommandAction]);

  return (
    <div className="flex flex-col h-screen bg-bg text-text">
      <Nav user={user} />
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && <ConversationList conversations={conversations} onNew={newConv} onChange={refreshConvs} />}
        <main className="flex-1 flex flex-col">
          {!id ? (
            <>
              <header className="border-b border-border px-6 py-3 flex justify-end items-center gap-1">
                <button
                  onClick={() => setRightOpen((v) => !v)}
                  className="text-text-muted hover:text-text hover:bg-surface-hover rounded-md p-1.5 transition-colors duration-150"
                  aria-label={rightOpen ? 'Hide context' : 'Show context'}
                  title={rightOpen ? 'Hide context' : 'Show context'}
                >
                  <PanelRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setSidebarOpen((v) => !v)}
                  className="text-text-muted hover:text-text hover:bg-surface-hover rounded-md p-1.5 transition-colors duration-150"
                  aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                  title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                >
                  <PanelLeft className="w-4 h-4" />
                </button>
              </header>
              <div className="flex-1 flex items-center justify-center text-text-muted">
                <div className="text-center">
                  <p className="mb-4">No conversation selected</p>
                  <button
                    onClick={newConv}
                    className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
                  >
                    Start a new one
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <header className="border-b border-border px-6 py-3 text-sm flex justify-between items-center gap-3">
                {renamingTitle ? (
                  <input
                    autoFocus
                    className="flex-1 bg-bg border border-accent rounded-md px-2 py-1 text-text outline-none text-sm"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename();
                      if (e.key === 'Escape') setRenamingTitle(false);
                    }}
                    onBlur={() => void commitRename()}
                    maxLength={200}
                  />
                ) : (
                  <button
                    onClick={startRename}
                    className="group flex items-center gap-2 text-left flex-1 truncate text-text-muted hover:text-text transition-colors duration-150"
                    title="Click to rename"
                  >
                    <span className="truncate">{currentTitle}</span>
                    <Pencil className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 text-text-subtle transition-opacity" />
                  </button>
                )}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => setRightOpen((v) => !v)}
                    className="text-text-muted hover:text-text hover:bg-surface-hover rounded-md p-1.5 transition-colors duration-150"
                    aria-label={rightOpen ? 'Hide context' : 'Show context'}
                    title={rightOpen ? 'Hide context' : 'Show context'}
                  >
                    <PanelRight className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setSidebarOpen((v) => !v)}
                    className="text-text-muted hover:text-text hover:bg-surface-hover rounded-md p-1.5 transition-colors duration-150"
                    aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                    title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                  >
                    <PanelLeft className="w-4 h-4" />
                  </button>
                </div>
              </header>
              {!streaming && history.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center max-w-md">
                    <p className="text-text-muted text-sm mb-4">Try asking</p>
                    <div className="grid grid-cols-1 gap-2">
                      {SUGGESTED_PROMPTS.map((s) => (
                        <button
                          key={s}
                          onClick={() => onSend(s)}
                          className="text-left bg-surface hover:bg-surface-hover rounded-md p-3 text-sm text-text transition-colors duration-150"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <MessageStream
                  history={history}
                  streaming={streaming}
                  onConfirmResolved={onConfirmResolved}
                  onSendSuggestion={onSendSuggestion}
                  busy={!!streaming && !streaming.done}
                  slashFooter={
                    slashActive ? (
                      <SlashMenu
                        commands={slashFiltered}
                        highlight={slashHighlight}
                        onSelect={selectCommand}
                        onHover={setSlashHighlight}
                      />
                    ) : null
                  }
                />
              )}
              <Composer
                ref={composerRef}
                value={composerText}
                onChange={setComposerText}
                disabled={!!streaming && !streaming.done}
                onSend={onSend}
                slashState={
                  slashActive
                    ? {
                        filtered: slashFiltered,
                        highlight: slashHighlight,
                        setHighlight: setSlashHighlight,
                        selectCommand,
                      }
                    : null
                }
              />
            </>
          )}
        </main>
        {rightOpen && <TaskContextPanel tasks={tasks} asOf={null} />}
      </div>
    </div>
  );
}
