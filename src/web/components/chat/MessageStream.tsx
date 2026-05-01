import { ToolCallPill } from './ToolCallPill.js';
import type { StreamMessage } from '../../hooks/use-message-stream.js';

type PersistedMessage = { id: string; role: string; content: any };

type Props = {
  history: PersistedMessage[];
  streaming: StreamMessage | null;
};

export function MessageStream({ history, streaming }: Props) {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {history.map((m) => {
        if (m.role === 'user') {
          return (
            <div key={m.id} className="flex justify-end">
              <div className="bg-[#1e2230] text-[#e8eaf0] rounded-2xl rounded-br-sm px-4 py-2 max-w-[75%] text-sm whitespace-pre-wrap">{m.content?.text}</div>
            </div>
          );
        }
        if (m.role === 'assistant') {
          const tu = (m.content?.tool_uses as Array<{ id: string; name: string }>) ?? [];
          return (
            <div key={m.id} className="text-[#c9cdd9] text-sm leading-relaxed whitespace-pre-wrap max-w-[92%]">
              {tu.length > 0 && <div className="mb-1">{tu.map((t) => <ToolCallPill key={t.id} name={t.name} ok={true} />)}</div>}
              {m.content?.text}
            </div>
          );
        }
        if (m.role === 'system_event') {
          return (
            <div key={m.id} className="bg-[#60a5fa]/[.07] border-l-2 border-[#60a5fa] rounded px-3 py-1.5 text-[12px] text-[#c9cdd9]">
              <span className="text-[#60a5fa] font-bold mr-2">●</span>
              {m.content?.text ?? '(system event)'}
            </div>
          );
        }
        return null;
      })}
      {streaming && (
        <div className="text-[#c9cdd9] text-sm leading-relaxed whitespace-pre-wrap max-w-[92%]">
          {streaming.toolCalls.length > 0 && (
            <div className="mb-1">{streaming.toolCalls.map((t) => (
              <ToolCallPill key={t.tool_use_id} name={t.tool_name} routerPath={t.router_path} latencyMs={t.latency_ms} ok={t.ok} />
            ))}</div>
          )}
          {streaming.text}
          {!streaming.done && <span className="inline-block w-2 h-4 bg-[#7c6ef7] ml-1 animate-pulse" />}
        </div>
      )}
    </div>
  );
}
