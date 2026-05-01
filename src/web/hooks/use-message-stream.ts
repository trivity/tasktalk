import { useCallback, useRef, useState } from 'react';
import { postSse } from '../lib/sse.js';

export type StreamMessage = {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: Array<{ tool_use_id: string; tool_name: string; router_path?: string; latency_ms?: number; ok?: boolean }>;
  pendingConfirmations: Array<{ token: string; tool_use_id: string; tool_name: string; preview: unknown }>;
  done: boolean;
};

export function useMessageStream(conversationId: string) {
  const [streaming, setStreaming] = useState<StreamMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (text: string, onComplete: () => void) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const draft: StreamMessage = { role: 'assistant', text: '', toolCalls: [], pendingConfirmations: [], done: false };
    setStreaming(draft);

    await postSse(
      `/api/chat/${conversationId}/turn`,
      { text },
      (e) => {
        if (e.event === 'done') return;
        const ev = JSON.parse(e.data) as any;
        if (ev.type === 'text_delta') draft.text += ev.text;
        else if (ev.type === 'tool_use_start') draft.toolCalls.push({ tool_use_id: ev.tool_use_id, tool_name: ev.tool_name });
        else if (ev.type === 'tool_use_complete') {
          const tc = draft.toolCalls.find((t) => t.tool_use_id === ev.tool_use_id);
          if (tc) { tc.router_path = ev.router_path; tc.latency_ms = ev.latency_ms; tc.ok = ev.ok; }
        } else if (ev.type === 'needs_confirmation') {
          draft.pendingConfirmations.push({ token: ev.confirmation_token, tool_use_id: ev.tool_use_id, tool_name: ev.tool_name, preview: ev.preview });
        } else if (ev.type === 'message_complete') {
          draft.done = true;
        } else if (ev.type === 'error') {
          draft.text += `\n\n[error: ${ev.error}]`;
          draft.done = true;
        }
        setStreaming({ ...draft });
      },
      ctrl.signal,
    );
    setStreaming(null);
    onComplete();
  }, [conversationId]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { streaming, send, cancel };
}
