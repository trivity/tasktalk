type Props = { text: string; ts?: string };

export function SystemEventNote({ text, ts }: Props) {
  return (
    <div className="bg-accent-soft border-l-4 border-accent rounded-md px-3 py-2 text-xs text-text flex items-center gap-2">
      <span className="text-accent font-semibold">●</span>
      <span>{text}</span>
      {ts && <span className="ml-auto text-text-subtle">{ts}</span>}
    </div>
  );
}
