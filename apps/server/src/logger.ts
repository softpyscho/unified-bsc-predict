/**
 * Structured logging in separate channels (app, strategy, tx, audit, error), JSON lines to stdout and to
 * logs/<channel>.log. Anything at level error from any channel is also written to logs/error.log.
 * The configured private key and admin token are scrubbed from every line before it is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { AppConfig } from './config.js';

export type LogChannel = 'app' | 'strategy' | 'tx' | 'audit';
export type Logger = pino.Logger;
export type Loggers = Record<LogChannel, Logger> & { close(): void };

const REDACT_PATHS = [
  'privateKey',
  '*.privateKey',
  'secret',
  '*.secret',
  'secrets',
  '*.secrets',
  'token',
  '*.token',
  'password',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
];

function scrubber(secrets: string[]): (line: string) => string {
  const values = secrets
    .flatMap((s) => (s.startsWith('0x') ? [s, s.slice(2)] : [s]))
    .filter((s) => s.length >= 16);
  return (line) => values.reduce((acc, s) => (acc.includes(s) ? acc.split(s).join('[REDACTED]') : acc), line);
}

export function createLoggers(config: Pick<AppConfig, 'logDir' | 'logLevel' | 'secrets'>): Loggers {
  const scrub = scrubber([config.secrets.privateKey ?? '', config.secrets.adminToken]);
  const open: pino.DestinationStream[] = [];
  const wrap = (dest: pino.DestinationStream): pino.DestinationStream => ({
    write: (msg: string) => dest.write(scrub(msg)),
  });
  const fileDest = (name: string) => {
    const d = pino.destination({ dest: path.join(config.logDir!, `${name}.log`), mkdir: true, sync: false });
    open.push(d);
    return wrap(d);
  };

  if (config.logDir) fs.mkdirSync(config.logDir, { recursive: true });
  const stdout = wrap(pino.destination({ fd: 1, sync: false }));
  const errorFile = config.logDir ? fileDest('error') : null;

  const make = (channel: LogChannel): Logger => {
    const streams: pino.StreamEntry[] = [{ level: 'trace', stream: stdout }];
    if (config.logDir) {
      streams.push({ level: 'trace', stream: fileDest(channel) });
      if (errorFile) streams.push({ level: 'error', stream: errorFile });
    }
    return pino(
      {
        level: config.logLevel,
        base: { channel },
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
        timestamp: pino.stdTimeFunctions.isoTime,
        serializers: { err: pino.stdSerializers.err },
      },
      pino.multistream(streams),
    );
  };

  return {
    app: make('app'),
    strategy: make('strategy'),
    tx: make('tx'),
    audit: make('audit'),
    close() {
      for (const d of open) {
        const f = d as unknown as { flushSync?: () => void };
        try {
          f.flushSync?.();
        } catch {
          // destination not ready yet; nothing to flush
        }
      }
    },
  };
}

/** Silent loggers for tests. */
export function silentLoggers(): Loggers {
  const l = pino({ level: 'silent' });
  return { app: l, strategy: l, tx: l, audit: l, close() {} };
}
