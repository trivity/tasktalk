type Props = { text: string; ts?: string };

export function SystemEventNote({ text, ts }: Props) {
  return (
    <div className="bg-[#60a5fa]/[.07] border-l-2 border-[#60a5fa] rounded px-3 py-1.5 text-xs text-[#c9cdd9] flex items-center gap-2">
      <span className="text-[#60a5fa] font-bold">●</span>
      <span>{text}</span>
      {ts && <span className="ml-auto text-[#5a6070]">{ts}</span>}
    </div>
  );
}
