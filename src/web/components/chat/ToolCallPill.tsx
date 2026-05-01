type Props = { name: string; routerPath?: string; latencyMs?: number; ok?: boolean };
export function ToolCallPill({ name, routerPath, latencyMs, ok }: Props) {
  const color = ok === false ? '#f87171' : routerPath === 'live' ? '#fbbf24' : '#34d399';
  return (
    <span
      className="group inline-flex items-center gap-1 text-[10.5px] tracking-wider uppercase rounded px-2 py-0.5 mr-1 bg-[#1a1d27] border border-[#2a2f3d]"
      style={{ color, opacity: 0.45 }}
      title={`${name} · ${routerPath ?? '…'} · ${latencyMs ?? 0}ms`}
    >
      <span className="opacity-0 group-hover:opacity-100 transition-opacity">{name}</span>
      <span className="group-hover:hidden">●</span>
    </span>
  );
}
