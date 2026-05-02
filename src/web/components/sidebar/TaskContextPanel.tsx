type Task = { id: string; name: string };

export function TaskContextPanel({ tasks, asOf }: { tasks: Task[]; asOf: string | null }) {
  return (
    <aside className="w-[260px] bg-surface border-l border-border p-4 overflow-y-auto">
      <h4 className="text-[10.5px] uppercase tracking-wider text-text-muted font-semibold mb-3">
        Tasks in this conversation
      </h4>
      {tasks.length === 0 && <p className="text-xs text-text-muted">No tasks referenced yet.</p>}
      {tasks.map((t) => (
        <div key={t.id} className="rounded-md p-2 mb-1 text-xs hover:bg-surface-hover transition-colors duration-150">
          <div className="font-medium text-text truncate">{t.name}</div>
          <div className="text-[10px] text-text-subtle mt-0.5">{t.id}</div>
        </div>
      ))}
      {asOf && (
        <div className="text-[10px] text-text-subtle mt-3 pt-3 border-t border-border italic">
          Mirror as-of {new Date(asOf).toLocaleTimeString()}
        </div>
      )}
    </aside>
  );
}
