import { useEffect, useState } from 'react';

type ThemeMode = 'system' | 'dark' | 'light';

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => (localStorage.getItem('tt_theme') as ThemeMode) ?? 'system');
  const [resolved, setResolved] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    function apply() {
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const r = mode === 'system' ? (sysDark ? 'dark' : 'light') : mode;
      setResolved(r);
      document.documentElement.dataset.theme = r;
    }
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mode === 'system') mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);

  function update(next: ThemeMode) {
    localStorage.setItem('tt_theme', next);
    setMode(next);
  }

  return { mode, resolved, setMode: update };
}
