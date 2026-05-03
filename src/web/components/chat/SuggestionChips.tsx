type Props = {
  suggestions: string[];
  onPick: (text: string) => void;
  disabled?: boolean;
};

export function SuggestionChips({ suggestions, onPick, disabled }: Props) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-text-subtle">What's next?</span>
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          disabled={disabled}
          className="text-xs text-text-muted bg-surface hover:bg-surface-hover hover:text-text border border-border rounded-full px-3 py-1.5 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {s}
        </button>
      ))}
    </div>
  );
}
