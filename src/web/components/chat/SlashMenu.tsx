import type { SlashCommand } from '../../lib/slash-commands.js';

type Props = {
  commands: SlashCommand[];
  highlight: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (idx: number) => void;
};

export function SlashMenu({ commands, highlight, onSelect, onHover }: Props) {
  if (commands.length === 0) return null;
  return (
    <div className="border border-border rounded-md bg-surface overflow-hidden max-w-[92%]" role="listbox">
      <div className="px-3 py-2 border-b border-border text-xs text-text-subtle uppercase tracking-wide">
        Slash commands
      </div>
      <ul>
        {commands.map((c, i) => (
          <li key={c.name}>
            <button
              type="button"
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(c)}
              className={`w-full text-left px-3 py-2 flex items-baseline gap-3 transition-colors duration-100 ${
                i === highlight ? 'bg-surface-hover' : 'hover:bg-surface-hover'
              }`}
            >
              <span className="font-mono text-sm text-text shrink-0 w-20">{c.label}</span>
              <span className="text-sm text-text-muted truncate">{c.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
