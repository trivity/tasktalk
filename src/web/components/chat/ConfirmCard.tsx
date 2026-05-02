import { useState } from 'react';

type Field = { key: string; before: unknown; after: unknown };
export type Preview = {
  kind: 'create_task' | 'update_task' | 'add_comment' | 'delete_task';
  target: { type: string; id: string; name: string };
  fields: Field[];
  destructive: boolean;
};

type Props = {
  preview: Preview;
  token: string;
  onResolved: () => void;
};

export function ConfirmCard({ preview, token, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const canConfirm = !preview.destructive || deleteConfirmText === 'DELETE';

  async function act(confirm: boolean) {
    setBusy(true);
    try {
      const res = await fetch('/api/confirm-write', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ confirmation_token: token, confirm }),
      });
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
    } finally {
      setBusy(false);
      onResolved();
    }
  }

  const titleByKind: Record<Preview['kind'], string> = {
    create_task: 'Create task in',
    update_task: 'Update task',
    add_comment: 'Comment on task',
    delete_task: 'Delete task',
  };

  return (
    <div
      className={`max-w-md rounded-md p-4 my-3 ${
        preview.destructive
          ? 'bg-error/10 border-l-4 border-error'
          : 'bg-warning/10 border-l-4 border-warning'
      }`}
    >
      <div
        className={`text-[10px] uppercase tracking-wider font-semibold mb-1 ${
          preview.destructive ? 'text-error' : 'text-warning'
        }`}
      >
        Confirm write to ClickUp
      </div>
      <div className="text-sm font-medium text-text mb-3">
        {titleByKind[preview.kind]}: <em>"{preview.target.name}"</em>
      </div>
      <div className="font-mono text-[11px] space-y-1 mb-3">
        {preview.fields.map((f) => (
          <div key={f.key}>
            <span className="text-text-muted">{f.key}</span>{' '}
            {f.before !== null && f.before !== undefined && (
              <span className="text-error line-through">{String(f.before)}</span>
            )}
            {f.before !== null &&
              f.before !== undefined &&
              f.after !== null &&
              f.after !== undefined && <span className="text-text-subtle mx-1">{'->'}</span>}
            {f.after !== null && f.after !== undefined && (
              <span className="text-success">
                {typeof f.after === 'object' ? JSON.stringify(f.after) : String(f.after)}
              </span>
            )}
          </div>
        ))}
      </div>
      {preview.destructive && (
        <input
          className="w-full mb-2 bg-bg border border-border rounded-md p-2 text-xs text-text outline-none focus:border-accent"
          placeholder="Type DELETE to confirm"
          value={deleteConfirmText}
          onChange={(e: any) => setDeleteConfirmText(e.target.value)}
        />
      )}
      <div className="flex gap-2">
        <button
          onClick={() => act(true)}
          disabled={!canConfirm || busy}
          className={`px-4 py-1.5 rounded-md text-xs font-medium text-white ${
            preview.destructive ? 'bg-error' : 'bg-accent hover:bg-accent-hover'
          } ${!canConfirm || busy ? 'opacity-50 cursor-not-allowed' : ''} transition-colors duration-150`}
        >
          Confirm
        </button>
        <button
          onClick={() => act(false)}
          disabled={busy}
          className="px-4 py-1.5 rounded-md text-xs bg-surface text-text hover:bg-surface-hover transition-colors duration-150"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
