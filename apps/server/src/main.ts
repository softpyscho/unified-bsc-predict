/** Server entry point: API + dashboard + background worker in one process. */
import fs from 'node:fs';
import { buildServer } from './api/server.js';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

async function main(): Promise<void> {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = await createApp(config);
  const server = await buildServer(app);
  await server.listen({ host: config.host, port: config.port });
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  app.log.app.info(
    {
      url: `http://${config.host}:${config.port}`,
      liveTradingEnabled: config.liveTradingEnabled,
      wallet: config.walletAddress,
    },
    'server listening',
  );
  if (!loopback) app.log.app.warn('listening beyond localhost: put the dashboard behind a TLS reverse proxy');
  app.worker.start();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.app.info({ signal }, 'shutting down');
    await server.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => app.log.app.error({ err }, 'unhandled rejection'));
}

void main();
