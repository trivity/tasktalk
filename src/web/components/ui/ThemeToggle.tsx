import { useTheme } from '../../hooks/use-theme.js';

type ThemeMode = 'system' | 'dark' | 'light';

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <select
      value={mode}
      onChange={(e) => setMode(e.target.value as ThemeMode)}
      className="bg-surface border border-border rounded-md text-sm px-2 py-1 text-text outline-none focus:border-accent"
    >
      <option value="system">System</option>
      <option value="dark">Dark</option>
      <option value="light">Light</option>
    </select>
  );
}
