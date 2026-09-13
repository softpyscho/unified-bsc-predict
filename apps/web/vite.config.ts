import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard runs on :5173 and proxies the API (including SSE) to the server on :8080.
// In production the server serves the built files from apps/web/dist.
// DEV_PROXY_BEARER (set only by scripts/dev-dashboard.mjs) is added server-side by the proxy; it is not a
// VITE_* variable, so it is never exposed to client code.
const bearer = process.env.DEV_PROXY_BEARER;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
        ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
