import { useState } from 'react';

type Props = { disabled: boolean; onSend: (text: string) => void };

export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState('');
  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim() && !disabled) { onSend(text); setText(''); }
    }
  }
  return (
    <div className="border-t border-[#2a2f3d] p-4">
      <textarea
        className="w-full bg-[#181b22] border border-[#2a2f3d] rounded-md p-3 text-sm text-[#e8eaf0] resize-none outline-none focus:border-[#7c6ef7]"
        rows={2}
        placeholder="Ask about your tasks…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKey}
        disabled={disabled}
      />
    </div>
  );
}
