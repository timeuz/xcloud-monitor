import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  // Must match `devUrl` in src-tauri/tauri.conf.json (Tauri starts this via beforeDevCommand).
  server: {
    host: 'localhost',
    port: 3030,
    strictPort: true,
  },
});
