import { useTheme } from '../../hooks/use-theme.js';

type ThemeMode = 'system' | 'dark' | 'light';

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <select
      value={mode}
      onChange={(e) => setMode(e.target.value as ThemeMode)}
      className="bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs px-2 py-1 text-[var(--text-muted)]"
    >
      <option value="system">System</option>
      <option value="dark">Dark</option>
      <option value="light">Light</option>
    </select>
  );
}
