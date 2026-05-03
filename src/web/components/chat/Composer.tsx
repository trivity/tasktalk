import { useState, useRef, useEffect } from 'react';
import { ArrowUp } from 'lucide-react';
import { filterSlashCommands, type SlashCommand } from '../../lib/slash-commands.js';
import { SlashMenu } from './SlashMenu.js';

type Props = {
  disabled: boolean;
  onSend: (text: string) => void;
  onCommandAction?: (action: 'refresh' | 'help') => void;
};

export function Composer({ disabled, onSend, onCommandAction }: Props) {
  const [text, setText] = useState('');
  const [highlight, setHighlight] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Open menu only while typing the slash-token (no whitespace yet).
  const slashMatch = text.match(/^\/(\S*)$/);
  const menuOpen = !!slashMatch;
  const query = slashMatch ? slashMatch[1] : '';
  const filtered = menuOpen ? filterSlashCommands(query) : [];

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered.length, highlight]);

  function selectCommand(cmd: SlashCommand) {
    if (cmd.kind === 'action') {
      onCommandAction?.(cmd.action!);
      setText('');
      setHighlight(0);
      taRef.current?.focus();
      return;
    }
    const next = cmd.prompt ?? '';
    setText(next);
    setHighlight(0);
    setTimeout(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(next.length, next.length);
      }
    }, 0);
  }

  function submit() {
    const trimmed = text.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      setText('');
      setHighlight(0);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = filtered[highlight];
        if (cmd) selectCommand(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
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
      <div className="relative">
        {menuOpen && filtered.length > 0 && (
          <SlashMenu
            commands={filtered}
            highlight={highlight}
            onSelect={selectCommand}
            onHover={setHighlight}
          />
        )}
        <div className="relative bg-surface rounded-lg border border-border focus-within:border-accent transition-colors duration-150">
          <textarea
            ref={taRef}
            className="w-full bg-transparent rounded-lg p-3 pr-14 text-[15px] text-text placeholder:text-text-subtle resize-none outline-none"
            rows={2}
            placeholder="Ask about your tasks…  (type / for commands)"
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
    </div>
  );
}
