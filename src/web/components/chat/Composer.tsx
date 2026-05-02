import { useState } from 'react';
import { ArrowUp } from 'lucide-react';

type Props = { disabled: boolean; onSend: (text: string) => void };

export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState('');

  function submit() {
    const trimmed = text.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      setText('');
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="px-6 py-4">
      <div className="relative bg-surface rounded-lg border border-border focus-within:border-accent transition-colors duration-150">
        <textarea
          className="w-full bg-transparent rounded-lg p-3 pr-14 text-[15px] text-text placeholder:text-text-subtle resize-none outline-none"
          rows={2}
          placeholder="Ask about your tasks…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          aria-label="Send message"
          className="absolute right-2 bottom-2 w-8 h-8 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
