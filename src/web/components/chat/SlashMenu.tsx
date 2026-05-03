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
    <div
      className="absolute left-0 right-0 bottom-full mb-2 max-h-72 overflow-y-auto bg-surface border border-border rounded-md shadow-lg z-10"
      role="listbox"
    >
      {commands.map((c, i) => (
        <button
          key={c.name}
          type="button"
          role="option"
          aria-selected={i === highlight}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // Prevent textarea blur before click fires
            e.preventDefault();
          }}
          onClick={() => onSelect(c)}
          className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors duration-100 ${
            i === highlight ? 'bg-surface-hover' : ''
          }`}
        >
          <span className="font-mono text-sm text-text shrink-0 w-20">{c.label}</span>
          <span className="text-xs text-text-muted truncate">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
