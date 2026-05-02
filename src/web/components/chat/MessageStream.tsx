import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolCallPill } from './ToolCallPill.js';
import { ConfirmCard, type Preview } from './ConfirmCard.js';
import { SystemEventNote } from './SystemEventNote.js';
import type { StreamMessage } from '../../hooks/use-message-stream.js';

type PersistedMessage = { id: string; role: string; content: any };

type Props = {
  history: PersistedMessage[];
  streaming: StreamMessage | null;
  onConfirmResolved: () => void;
};

const markdownComponents = {
  p: ({ children }: any) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }: any) => <h1 className="font-semibold text-[24px] mt-4 mb-2 leading-tight">{children}</h1>,
  h2: ({ children }: any) => <h2 className="font-semibold text-[18px] mt-4 mb-2 leading-tight">{children}</h2>,
  h3: ({ children }: any) => <h3 className="font-semibold text-[15px] mt-4 mb-2 leading-tight">{children}</h3>,
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>,
  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
  code: ({ inline, children }: any) =>
    inline ? (
      <code className="bg-surface px-1 py-0.5 rounded text-sm font-mono">{children}</code>
    ) : (
      <code className="font-mono text-sm">{children}</code>
    ),
  pre: ({ children }: any) => (
    <pre className="bg-surface p-3 rounded-md overflow-x-auto text-sm font-mono mb-3">{children}</pre>
  ),
  table: ({ children }: any) => <table className="w-full my-3 text-sm border-collapse">{children}</table>,
  th: ({ children }: any) => (
    <th className="border-b border-border px-3 py-2 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: any) => <td className="border-b border-border px-3 py-2 text-left">{children}</td>,
  a: ({ children, href }: any) => (
    <a href={href} className="text-accent underline hover:no-underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-border pl-3 my-3 text-text-muted italic">{children}</blockquote>
  ),
  hr: () => <hr className="border-border my-4" />,
};

export function MessageStream({ history, streaming, onConfirmResolved }: Props) {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-8 space-y-5">
      {history.map((m) => {
        if (m.role === 'user') {
          return (
            <div key={m.id} className="flex justify-end">
              <div className="bg-accent-soft text-text rounded-2xl rounded-br-sm px-4 py-2 max-w-[75%] text-[15px] whitespace-pre-wrap">
                {m.content?.text}
              </div>
            </div>
          );
        }
        if (m.role === 'assistant') {
          const tu = (m.content?.tool_uses as Array<{ id: string; name: string }>) ?? [];
          const text = m.content?.text ?? '';
          return (
            <div key={m.id} className="text-text text-[15px] leading-relaxed max-w-[92%]">
              {tu.length > 0 && (
                <div className="mb-2">
                  {tu.map((t) => (
                    <ToolCallPill key={t.id} name={t.name} ok={true} />
                  ))}
                </div>
              )}
              {text && (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {text}
                </ReactMarkdown>
              )}
            </div>
          );
        }
        if (m.role === 'system_event') {
          return <SystemEventNote key={m.id} text={m.content?.text ?? '(system event)'} />;
        }
        return null;
      })}
      {streaming && (
        <div className="text-text text-[15px] leading-relaxed max-w-[92%]">
          {streaming.toolCalls.length > 0 && (
            <div className="mb-2">
              {streaming.toolCalls.map((t) => (
                <ToolCallPill
                  key={t.tool_use_id}
                  name={t.tool_name}
                  routerPath={t.router_path}
                  latencyMs={t.latency_ms}
                  ok={t.ok}
                />
              ))}
            </div>
          )}
          {streaming.text && (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {streaming.text}
            </ReactMarkdown>
          )}
          {!streaming.done && <span className="inline-block w-2 h-4 bg-accent ml-1 animate-pulse align-middle" />}
          {streaming.pendingConfirmations.map((p) => (
            <ConfirmCard key={p.token} preview={p.preview as Preview} token={p.token} onResolved={onConfirmResolved} />
          ))}
        </div>
      )}
    </div>
  );
}
