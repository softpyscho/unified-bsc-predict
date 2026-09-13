import type { AppConfig } from '../config.js';
import type { PredictionReader, PredictionWriter } from '../chain/types.js';
import type { Loggers } from '../logger.js';
import type { Repos } from '../repositories/index.js';
import type { AuditLog } from './audit.js';
import type { EventBus } from './events.js';

export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

/** Shared infrastructure handed to every service (explicit dependency injection, no globals). */
export interface Ctx {
  config: AppConfig;
  repos: Repos;
  log: Loggers;
  bus: EventBus;
  audit: AuditLog;
  reader: PredictionReader;
  writer: PredictionWriter | null;
  clock: Clock;
}
