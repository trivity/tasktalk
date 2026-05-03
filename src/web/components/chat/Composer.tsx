import { forwardRef } from 'react';
import { ArrowUp } from 'lucide-react';
import type { SlashCommand } from '../../lib/slash-commands.js';

export type SlashState = {
  filtered: SlashCommand[];
  highlight: number;
  setHighlight: (idx: number) => void;
  selectCommand: (cmd: SlashCommand) => void;
};

type Props = {
  value: string;
  onChange: (text: string) => void;
  disabled: boolean;
  onSend: (text: string) => void;
  slashState: SlashState | null;
};

export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(
  { value, onChange, disabled, onSend, slashState },
  ref,
) {
  function submit() {
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      onChange('');
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashState && slashState.filtered.length > 0) {
      const len = slashState.filtered.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashState.setHighlight((slashState.highlight + 1) % len);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashState.setHighlight((slashState.highlight - 1 + len) % len);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = slashState.filtered[slashState.highlight];
        if (cmd) slashState.selectCommand(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onChange('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="px-6 py-4">
      <div className="relative bg-surface rounded-lg border border-border focus-within:border-accent transition-colors duration-150">
        <textarea
          ref={ref}
          className="w-full bg-transparent rounded-lg p-3 pr-14 text-[15px] text-text placeholder:text-text-subtle resize-none outline-none"
          rows={2}
          placeholder="Ask about your tasks…  (type / for commands)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          className="absolute right-2 bottom-2 w-8 h-8 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
});
