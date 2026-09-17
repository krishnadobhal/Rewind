import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4100,
    // The viewer has no backend of its own — it reads the same /v1 routes the SDK
    // writes to. One API, whether it is backed by Postgres or a directory.
    proxy: { '/v1': { target: process.env['REWIND_SERVER'] ?? 'http://localhost:4000', changeOrigin: true } },
  },
});
