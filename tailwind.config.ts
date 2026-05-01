import type { Config } from 'tailwindcss';
export default {
  content: ['./src/web/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: { extend: { colors: { accent: '#7c6ef7' } } },
  plugins: [],
} satisfies Config;
