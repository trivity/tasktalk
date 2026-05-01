import { useState } from 'react';
import { useParams } from 'react-router-dom';

export function UndoChip({ onUndone }: { onUndone: () => void }) {
  const { id } = useParams();
  const [busy, setBusy] = useState(false);
  if (!id) return null;

  async function undo() {
    setBusy(true);
    try {
      const res = await fetch(`/api/undo/${id}`, {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'text/event-stream' },
      });
      if (res.body) {
        const r = res.body.getReader();
        while (true) {
          const { done } = await r.read();
          if (done) break;
        }
      }
    } finally {
      setBusy(false);
      onUndone();
    }
  }

  return (
    <button
      onClick={undo}
      disabled={busy}
      className="text-[11px] uppercase tracking-wide rounded px-2 py-0.5 border border-[#2a2f3d] text-[#a78bfa] hover:bg-[#1a1d27]"
    >
      {busy ? 'Undoing...' : '↶ Undo'}
    </button>
  );
}
