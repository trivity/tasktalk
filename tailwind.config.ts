import type { Config } from 'tailwindcss';
export default {
  content: ['./src/web/**/*.{ts,tsx,html}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-hover': 'var(--surface-hover)',
        'surface-active': 'var(--surface-active)',
        border: 'var(--border)',
        text: 'var(--text)',
        'text-muted': 'var(--text-muted)',
        'text-subtle': 'var(--text-subtle)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-soft': 'var(--accent-soft)',
        success: 'var(--success)',
        error: 'var(--error)',
        warning: 'var(--warning)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
