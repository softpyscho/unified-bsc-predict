/**
 * Bot lifecycle. The persisted status (bot_state) is the single source of truth, re-read on every check, so the
 * CLI can control a running server through the database. Trading additionally requires phase READY, which is
 * only reached after restart recovery completes.
 */
import type { BotStateRow, BotStatus } from '../repositories/index.js';
import { AuditType } from './audit.js';
import type { Ctx } from './context.js';

export type BotPhase = 'RECOVERING' | 'READY';

export const LIVE_CONFIRMATION_PHRASE = 'ENABLE LIVE TRADING';

export class BotError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'BotError';
  }
}

export interface BotView extends BotStateRow {
  phase: BotPhase;
  canTrade: boolean;
  liveTradingEnabled: boolean;
  paperTradingEnabled: boolean;
  hasSigner: boolean;
  walletAddress: string | null;
  maxExecutionFailures: number;
}

export class BotController {
  private phaseValue: BotPhase = 'RECOVERING';

  constructor(private readonly ctx: Ctx) {}

  get phase(): BotPhase {
    return this.phaseValue;
  }

  async setPhase(phase: BotPhase): Promise<void> {
    this.phaseValue = phase;
    await this.emit();
  }

  async view(): Promise<BotView> {
    const s = await this.ctx.repos.bot.get();
    return {
      ...s,
      phase: this.phaseValue,
      canTrade: this.phaseValue === 'READY' && s.status === 'RUNNING',
      liveTradingEnabled: this.ctx.config.liveTradingEnabled,
      paperTradingEnabled: this.ctx.config.paperTradingEnabled,
      hasSigner: this.ctx.writer !== null,
      walletAddress: this.ctx.config.walletAddress,
      maxExecutionFailures: this.ctx.config.maxExecutionFailures,
    };
  }

  async canTrade(): Promise<boolean> {
    return this.phaseValue === 'READY' && (await this.ctx.repos.bot.get()).status === 'RUNNING';
  }

  async start(reason = 'operator'): Promise<BotView> {
    const cur = await this.ctx.repos.bot.get();
    if (cur.status === 'EMERGENCY_STOPPED')
      throw new BotError('bot is emergency-stopped; reset the emergency stop first');
    if (cur.status === 'RUNNING') return this.view();
    await this.set('RUNNING', reason, AuditType.BOT_STARTED, 'INFO', `bot started (${reason})`);
    return this.view();
  }

  async stop(reason = 'operator'): Promise<BotView> {
    const cur = await this.ctx.repos.bot.get();
    if (cur.status === 'EMERGENCY_STOPPED')
      throw new BotError('bot is emergency-stopped; reset the emergency stop first');
    await this.ctx.repos.bot.update({ liveArmed: false, liveArmedAt: null });
    await this.set(
      'STOPPED',
      reason,
      AuditType.BOT_STOPPED,
      'INFO',
      `bot stopped (${reason}); live trading disarmed`,
    );
    return this.view();
  }

  async pause(reason = 'operator'): Promise<BotView> {
    const cur = await this.ctx.repos.bot.get();
    if (cur.status !== 'RUNNING') throw new BotError(`cannot pause from ${cur.status}`);
    await this.set('PAUSED', reason, AuditType.BOT_PAUSED, 'INFO', `bot paused (${reason})`);
    return this.view();
  }

  async resume(reason = 'operator'): Promise<BotView> {
    const cur = await this.ctx.repos.bot.get();
    if (cur.status !== 'PAUSED') throw new BotError(`cannot resume from ${cur.status}`);
    await this.set('RUNNING', reason, AuditType.BOT_RESUMED, 'INFO', `bot resumed (${reason})`);
    return this.view();
  }

  /** Immediately blocks all new executions and disarms live trading. In-flight broadcasts cannot be recalled. */
  async emergencyStop(reason = 'operator'): Promise<BotView> {
    await this.ctx.repos.bot.update({ liveArmed: false, liveArmedAt: null });
    await this.set(
      'EMERGENCY_STOPPED',
      reason,
      AuditType.EMERGENCY_STOP,
      'CRITICAL',
      `EMERGENCY STOP: ${reason}`,
    );
    return this.view();
  }

  async resetEmergency(acknowledge: boolean): Promise<BotView> {
    const cur = await this.ctx.repos.bot.get();
    if (cur.status !== 'EMERGENCY_STOPPED') throw new BotError('bot is not emergency-stopped');
    if (!acknowledge) throw new BotError('acknowledge=true is required to reset an emergency stop');
    await this.ctx.repos.bot.update({ consecutiveFailures: 0 });
    await this.set(
      'STOPPED',
      'emergency stop reset',
      AuditType.EMERGENCY_RESET,
      'WARN',
      'emergency stop reset by operator',
    );
    return this.view();
  }

  async armLive(confirmation: string): Promise<BotView> {
    const { config, repos } = this.ctx;
    if (!config.liveTradingEnabled)
      throw new BotError('LIVE_TRADING_ENABLED is false in the server environment');
    if (!this.ctx.writer) throw new BotError('no signing wallet configured (PRIVATE_KEY)');
    if ((await repos.bot.get()).status === 'EMERGENCY_STOPPED')
      throw new BotError('bot is emergency-stopped');
    if (confirmation !== LIVE_CONFIRMATION_PHRASE)
      throw new BotError(`confirmation must be exactly "${LIVE_CONFIRMATION_PHRASE}"`);
    await repos.bot.update({
      liveArmed: true,
      liveArmedAt: new Date().toISOString(),
      consecutiveFailures: 0,
    });
    await this.ctx.audit.record({
      component: 'bot',
      severity: 'WARN',
      type: AuditType.LIVE_TRADING_ARMED,
      message: `live trading armed for wallet ${this.ctx.writer.address}`,
    });
    await this.emit();
    return this.view();
  }

  async disarmLive(reason = 'operator'): Promise<BotView> {
    if (!(await this.ctx.repos.bot.get()).liveArmed) return this.view();
    await this.ctx.repos.bot.update({ liveArmed: false, liveArmedAt: null });
    await this.ctx.audit.record({
      component: 'bot',
      severity: 'WARN',
      type: AuditType.LIVE_TRADING_DISARMED,
      message: `live trading disarmed (${reason})`,
    });
    await this.emit();
    return this.view();
  }

  /** Circuit breaker: repeated execution failures pause the bot and disarm live trading. */
  async recordExecutionFailure(detail: string): Promise<void> {
    const { repos, config } = this.ctx;
    const n = (await repos.bot.get()).consecutiveFailures + 1;
    await repos.bot.update({ consecutiveFailures: n });
    if (n >= config.maxExecutionFailures) {
      await repos.bot.update({ liveArmed: false, liveArmedAt: null });
      const cur = await repos.bot.get();
      if (cur.status === 'RUNNING')
        await repos.bot.update({ status: 'PAUSED', statusReason: 'circuit breaker' });
      await this.ctx.audit.record({
        component: 'bot',
        severity: 'CRITICAL',
        type: AuditType.RISK_LIMIT_TRIGGERED,
        message: `circuit breaker: ${n} consecutive execution failures (limit ${config.maxExecutionFailures}); bot paused, live trading disarmed. Last error: ${detail}`,
        metadata: { rule: 'CIRCUIT_BREAKER', consecutiveFailures: n },
      });
    }
    await this.emit();
  }

  async recordExecutionSuccess(): Promise<void> {
    if ((await this.ctx.repos.bot.get()).consecutiveFailures > 0)
      await this.ctx.repos.bot.update({ consecutiveFailures: 0 });
  }

  private async set(
    status: BotStatus,
    reason: string,
    type: string,
    severity: 'INFO' | 'WARN' | 'CRITICAL',
    message: string,
  ): Promise<void> {
    await this.ctx.repos.bot.update({ status, statusReason: reason });
    await this.ctx.audit.record({ component: 'bot', severity, type, message });
    await this.emit();
  }

  private async emit(): Promise<void> {
    this.ctx.bus.emit('bot', await this.view());
  }
}
