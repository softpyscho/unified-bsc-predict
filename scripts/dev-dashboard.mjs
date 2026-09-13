#!/usr/bin/env node
// Development only: runs the Vite dashboard on http://127.0.0.1:5173 and has the Vite proxy (Node side) add
// `Authorization: Bearer <ADMIN_API_TOKEN from .env>` to /api requests, so a local browser session is
// authenticated without typing the token. The token is never sent to the browser or embedded in the bundle.
// Never use this on a shared machine.
import { existsSync } from 'node:fs';
import { createServer } from 'vite';

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.ADMIN_API_TOKEN) {
  console.error('ADMIN_API_TOKEN is not set (.env)');
  process.exit(1);
}
process.env.DEV_PROXY_BEARER = process.env.ADMIN_API_TOKEN;

const server = await createServer({
  configFile: 'apps/web/vite.config.ts',
  root: 'apps/web',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
await server.listen();
server.printUrls();
