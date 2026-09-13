import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import type { App } from '../app.js';
import { stringify } from '../util/json.js';
import { SESSION_COOKIE, Sessions } from './auth.js';
import { registerRoutes } from './routes.js';

const PUBLIC_API = new Set(['/api/health', '/api/auth/login']);

export function resolveWebDir(configured: string | null): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured,
    path.resolve(process.cwd(), 'apps/web/dist'),
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../../../web/dist'),
  ].filter((p): p is string => p !== null);
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? null;
}

export async function buildServer(app: App): Promise<FastifyInstance> {
  const server = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false });
  const sessions = new Sessions(app.config.secrets.adminToken);

  await server.register(cookie);
  // bigint (wei) values are serialized as decimal strings.
  server.setReplySerializer((payload) => stringify(payload));

  server.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    return payload;
  });

  server.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/') || PUBLIC_API.has(url)) return;
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined;
    const authed = sessions.valid(req.cookies[SESSION_COOKIE]) || sessions.verifyToken(bearer);
    if (!authed) return reply.code(401).send({ error: 'authentication required' });
    // Mutations must be same-origin (SameSite=Strict cookie + Origin check).
    if (req.method !== 'GET' && req.headers.origin) {
      const host = req.headers.host;
      if (!host || new URL(req.headers.origin).host !== host)
        return reply.code(403).send({ error: 'cross-origin request rejected' });
    }
  });

  server.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err instanceof Error ? err.message : 'request error' });
    }
    app.log.app.error({ err, url: req.url, method: req.method }, 'request failed');
    return reply.code(500).send({ error: 'internal server error' });
  });

  registerRoutes(server, app, sessions);

  const webDir = app.config.serveWeb ? resolveWebDir(app.config.webDistDir) : null;
  if (webDir) {
    await server.register(fastifyStatic, { root: webDir, wildcard: false });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    server.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  }
  app.log.app.info({ webDir }, webDir ? 'serving dashboard' : 'dashboard build not found; API only');
  return server;
}
