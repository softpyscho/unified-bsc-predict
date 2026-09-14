/** Append-only audit trail: persisted (DB triggers forbid UPDATE/DELETE), logged, and streamed to the dashboard. */
import type { Logger } from '../logger.js';
import type { AuditEvent, AuditInput, Repos } from '../repositories/index.js';
import type { EventBus } from './events.js';

export const AuditType = {
  ROUND_DETECTED: 'ROUND_DETECTED',
  ROUND_UPDATED: 'ROUND_UPDATED',
  ROUND_SETTLED: 'ROUND_SETTLED',
  ROUND_CORRECTED: 'ROUND_CORRECTED',
  ROUND_CONFLICT: 'ROUND_CONFLICT',
  SIGNAL_GENERATED: 'SIGNAL_GENERATED',
  TRADE_APPROVED: 'TRADE_APPROVED',
  TRADE_REJECTED: 'TRADE_REJECTED',
  BET_SUBMITTED: 'BET_SUBMITTED',
  BET_CONFIRMED: 'BET_CONFIRMED',
  BET_FAILED: 'BET_FAILED',
  BET_STATUS_UNKNOWN: 'BET_STATUS_UNKNOWN',
  TRADE_SETTLED: 'TRADE_SETTLED',
  TRADE_IMPORTED: 'TRADE_IMPORTED',
  PAYOUT_DETECTED: 'PAYOUT_DETECTED',
  PAYOUT_CLAIMED: 'PAYOUT_CLAIMED',
  CLAIM_FAILED: 'CLAIM_FAILED',
  STRATEGY_ENABLED: 'STRATEGY_ENABLED',
  STRATEGY_DISABLED: 'STRATEGY_DISABLED',
  STRATEGY_CONFIG_CHANGED: 'STRATEGY_CONFIG_CHANGED',
  STRATEGY_ERROR: 'STRATEGY_ERROR',
  BOT_STARTED: 'BOT_STARTED',
  BOT_STOPPED: 'BOT_STOPPED',
  BOT_PAUSED: 'BOT_PAUSED',
  BOT_RESUMED: 'BOT_RESUMED',
  LIVE_TRADING_ARMED: 'LIVE_TRADING_ARMED',
  LIVE_TRADING_DISARMED: 'LIVE_TRADING_DISARMED',
  RISK_LIMIT_TRIGGERED: 'RISK_LIMIT_TRIGGERED',
  EMERGENCY_STOP: 'EMERGENCY_STOP',
  EMERGENCY_RESET: 'EMERGENCY_RESET',
  RECOVERY_STARTED: 'RECOVERY_STARTED',
  RECOVERY_COMPLETED: 'RECOVERY_COMPLETED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  HISTORY_SYNCED: 'HISTORY_SYNCED',
  HISTORY_IMPORTED: 'HISTORY_IMPORTED',
  RECONCILE_COMPLETED: 'RECONCILE_COMPLETED',
  RPC_UNAVAILABLE: 'RPC_UNAVAILABLE',
  RPC_RECOVERED: 'RPC_RECOVERED',
  WALLET_ADDED: 'WALLET_ADDED',
  AUTH_FAILED: 'AUTH_FAILED',
  POOL_EVENTS_GAP: 'POOL_EVENTS_GAP',
  POOL_EVENTS_BACKFILL_STOPPED: 'POOL_EVENTS_BACKFILL_STOPPED',
  RESEARCH_COMPLETED: 'RESEARCH_COMPLETED',
  RESEARCH_FAILED: 'RESEARCH_FAILED',
} as const;

const LEVEL = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error', CRITICAL: 'fatal' } as const;

export class AuditLog {
  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  async record(e: AuditInput): Promise<AuditEvent> {
    const event = await this.repos.audit.append(e);
    this.log[LEVEL[e.severity]](
      {
        type: e.type,
        component: e.component,
        epoch: e.epoch ?? undefined,
        strategyId: e.strategyId ?? undefined,
        tradeId: e.tradeId ?? undefined,
        txHash: e.txHash ?? undefined,
        metadata: e.metadata ?? undefined,
      },
      e.message,
    );
    this.bus.emit('audit', event);
    return event;
  }
}
