import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
      '/s/': 'http://127.0.0.1:8788',
      '/u/': 'http://127.0.0.1:8788',
      '/join/': 'http://127.0.0.1:8788',
    },
  },
});
