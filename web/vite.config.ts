import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.SERVIFY_API ?? 'http://127.0.0.1:7700';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/mcp': { target, changeOrigin: false },
    },
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
