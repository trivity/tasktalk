import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Play, Pencil, Trash2, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/rpc.js';
import { Nav } from '../components/Nav.js';
import { RoutineForm, type RoutineFormValues } from '../components/routines/RoutineForm.js';

type Routine = Awaited<ReturnType<typeof api.listRoutines>>['routines'][number];

export function Routines() {
  const nav = useNavigate();
  const [user, setUser] = useState<{ email: string; name: string | null; isAdmin: boolean } | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [editing, setEditing] = useState<Routine | 'new' | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api.listRoutines();
    setRoutines(r.routines);
  }, []);

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => nav('/login'));
    void refresh();
  }, [nav, refresh]);

  async function onCreate(values: RoutineFormValues) {
    await api.createRoutine(values);
    toast.success('Routine created.');
    setEditing(null);
    void refresh();
  }

  async function onUpdate(id: string, values: RoutineFormValues) {
    await api.updateRoutine(id, values);
    toast.success('Routine updated.');
    setEditing(null);
    void refresh();
  }

  async function onToggle(r: Routine) {
    await api.updateRoutine(r.id, { enabled: !r.enabled });
    void refresh();
  }

  async function onDelete(r: Routine) {
    if (!window.confirm(`Delete routine "${r.name}"? This also removes its conversation history.`)) return;
    await api.deleteRoutine(r.id);
    toast.success('Routine deleted.');
    void refresh();
  }

  async function onRunNow(r: Routine) {
    setRunning(r.id);
    try {
      await api.runRoutineNow(r.id);
      toast.success('Routine ran. Check the conversation for the report.');
      await refresh();
    } catch (e: any) {
      toast.error(`Run failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setRunning(null);
    }
  }

  if (!user) return null;

  return (
    <div className="min-h-screen flex flex-col bg-bg text-text">
      <Nav user={user} />
      <div className="max-w-3xl mx-auto w-full p-10 space-y-6">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-[32px] font-semibold leading-tight">Routines</h1>
            <p className="text-sm text-text-muted mt-1">
              Recurring questions that produce a report. Delivered to a conversation, optionally emailed.
            </p>
          </div>
          {editing === null && (
            <button
              onClick={() => setEditing('new')}
              className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium inline-flex items-center gap-2 transition-colors duration-150"
            >
              <Plus className="w-4 h-4" />
              <span>New routine</span>
            </button>
          )}
        </header>

        {editing === 'new' && (
          <RoutineForm
            defaultEmail={user.email}
            onCancel={() => setEditing(null)}
            onSubmit={onCreate}
          />
        )}
        {editing && editing !== 'new' && (
          <RoutineForm
            initial={{
              name: editing.name,
              prompt: editing.prompt,
              schedule: editing.schedule,
              timezone: editing.timezone,
              deliverChat: editing.deliverChat,
              deliverEmail: editing.deliverEmail,
              emailTo: editing.emailTo,
              enabled: editing.enabled,
            }}
            defaultEmail={user.email}
            onCancel={() => setEditing(null)}
            onSubmit={(v) => onUpdate(editing.id, v)}
          />
        )}

        {routines === null ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : routines.length === 0 ? (
          <div className="text-center py-12 text-text-muted text-sm">
            No routines yet. Create one to get a recurring report.
          </div>
        ) : (
          <ul className="divide-y divide-border border border-border rounded-md overflow-hidden">
            {routines.map((r) => {
              const lastRunSuffix = r.lastRun
                ? r.lastRun.status === 'error'
                  ? <span className="text-error"> · last run failed</span>
                  : <span> · last run {new Date(r.lastRun.startedAt).toLocaleString()}</span>
                : <span className="text-text-subtle"> · never run</span>;
              return (
                <li key={r.id} className="px-4 py-3 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className={`font-medium ${r.enabled ? 'text-text' : 'text-text-subtle line-through'}`}>{r.name}</span>
                      {!r.enabled && <span className="text-xs text-text-subtle">(disabled)</span>}
                    </div>
                    <div className="text-xs text-text-muted mt-0.5">
                      <span>{r.scheduleDescription}</span>
                      {r.deliverEmail && <span> · email to {r.emailTo ?? user.email}</span>}
                      {lastRunSuffix}
                    </div>
                    <div className="text-xs text-text-subtle mt-1 italic truncate">"{r.prompt}"</div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => nav(`/chat/${r.conversationId}`)}
                      className="text-text-muted hover:text-text hover:bg-surface-hover rounded-md p-1.5 transition-colors duration-150"
                      title="Open conversation"
                    >
                      <MessageCircle className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onRunNow(r)}
                      disabled={running === r.id}
                      className="text-text-muted hover:text-text hover:bg-surface-hover rounded-md p-1.5 disabled:opacity-50 transition-colors duration-150"
                      title="Run now"
                    >
                      <Play className={`w-4 h-4 ${running === r.id ? 'animate-pulse' : ''}`} />
                    </button>
                    <button
                      onClick={() => onToggle(r)}
                      className="text-xs text-text-muted hover:text-text hover:bg-surface-hover rounded-md px-2 py-1 transition-colors duration-150"
                      title={r.enabled ? 'Disable' : 'Enable'}
                    >
                      {r.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => setEditing(r)}
                      className="text-text-muted hover:text-text hover:bg-surface-hover rounded-md p-1.5 transition-colors duration-150"
                      title="Edit"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onDelete(r)}
                      className="text-error hover:bg-error/10 rounded-md p-1.5 transition-colors duration-150"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
