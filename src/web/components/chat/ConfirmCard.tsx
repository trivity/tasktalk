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
      // read the stream so the server-side runTurn completes; we ignore the body and
      // rely on the parent reloading conversation history.
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
      className={`max-w-md rounded-xl border-2 p-4 my-2 ${
        preview.destructive ? 'border-[#f87171] bg-[#f87171]/[.06]' : 'border-[#fbbf24] bg-[#fbbf24]/[.06]'
      }`}
    >
      <div
        className={`text-[10px] uppercase tracking-wider font-bold mb-1 ${
          preview.destructive ? 'text-[#f87171]' : 'text-[#fbbf24]'
        }`}
      >
        Confirm write to ClickUp
      </div>
      <div className="text-sm font-semibold text-[#e8eaf0] mb-2">
        {titleByKind[preview.kind]}: <em>"{preview.target.name}"</em>
      </div>
      <div className="font-mono text-[11px] space-y-1 mb-3">
        {preview.fields.map((f) => (
          <div key={f.key}>
            <span className="text-[#9298ac]">{f.key}</span>{' '}
            {f.before !== null && f.before !== undefined && (
              <span className="text-[#f87171] line-through">{String(f.before)}</span>
            )}
            {f.before !== null &&
              f.before !== undefined &&
              f.after !== null &&
              f.after !== undefined && <span className="text-[#5a6070] mx-1">{'->'}</span>}
            {f.after !== null && f.after !== undefined && (
              <span className="text-[#34d399]">
                {typeof f.after === 'object' ? JSON.stringify(f.after) : String(f.after)}
              </span>
            )}
          </div>
        ))}
      </div>
      {preview.destructive && (
        <input
          className="w-full mb-2 bg-[#0f1117] border border-[#2a2f3d] rounded p-2 text-xs"
          placeholder="Type DELETE to confirm"
          value={deleteConfirmText}
          onChange={(e: any) => setDeleteConfirmText(e.target.value)}
        />
      )}
      <div className="flex gap-2">
        <button
          onClick={() => act(true)}
          disabled={!canConfirm || busy}
          className={`px-4 py-1.5 rounded text-xs font-semibold ${
            preview.destructive ? 'bg-[#f87171] text-[#0a0b0f]' : 'bg-[#34d399] text-[#0a0b0f]'
          } ${!canConfirm || busy ? 'opacity-50' : ''}`}
        >
          Confirm
        </button>
        <button
          onClick={() => act(false)}
          disabled={busy}
          className="px-4 py-1.5 rounded text-xs bg-[#2a2f3d] text-[#c9cdd9]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
