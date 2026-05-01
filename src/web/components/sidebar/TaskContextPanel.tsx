type Task = { id: string; name: string };

export function TaskContextPanel({ tasks, asOf }: { tasks: Task[]; asOf: string | null }) {
  return (
    <aside className="w-[260px] bg-[var(--surface-2)] border-l border-[var(--border)] p-3 overflow-y-auto">
      <h4 className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] font-bold mb-2">Tasks in this conversation</h4>
      {tasks.length === 0 && <p className="text-xs text-[var(--text-muted)]">No tasks referenced yet.</p>}
      {tasks.map((t) => (
        <div key={t.id} className="bg-[var(--surface)] border border-[var(--border)] rounded p-2 mb-2 text-xs">
          <div className="font-semibold text-[var(--text)] truncate">{t.name}</div>
          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{t.id}</div>
        </div>
      ))}
      {asOf && <div className="text-[10px] text-[var(--text-muted)] mt-2 pt-2 border-t border-[var(--border)] italic">Mirror as-of {new Date(asOf).toLocaleTimeString()}</div>}
    </aside>
  );
}
