import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/web'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
