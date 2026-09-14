/**
 * Execution adapters. The decision pipeline is identical for every mode; only this step differs:
 *  - PAPER: the trade is filled at decision time with simulated gas;
 *  - LIVE:  pre-flight validation against fresh chain state, local signing, tx hash persisted BEFORE broadcast,
 *           broadcast, receipt, and classified failures feeding the circuit breaker.
 * A transaction is never re-created after a crash or error: an unknown outcome is left for the reconciler, which
 * resolves it from the receipt or the contract ledger.
 */
import type { Decision, TradeMode } from '@bsc/core';
import { weiToBnbString } from '@bsc/core';
import type { Hex, TxReceipt } from '../chain/types.js';
import { classifyError, ExecutionError } from '../chain/types.js';
import { isUniqueViolation } from '../db/database.js';
import type { NewDecision } from '../repositories/decisions.js';
import type { DecisionRecord, Market, StoredRound, StrategyRow, Trade } from '../repositories/index.js';
import { AuditType } from './audit.js';
import type { BotController } from './bot.js';
import type { Ctx } from './context.js';
import { BET_GAS_ESTIMATE } from './riskState.js';

export const RECEIPT_TIMEOUT_MS = 60_000;

export interface PlaceInput {
  strategy: StrategyRow;
  market: Market;
  round: StoredRound;
  mode: TradeMode;
  source: 'BOT' | 'MANUAL';
  decision: Decision;
  record: NewDecision;
}

export interface PlaceResult {
  decision: DecisionRecord;
  trade: Trade | null;
  submission: Promise<Trade> | null;
}

const violatesUniqueOn = (err: unknown, table: string) =>
  isUniqueViolation(err) && (err as { table?: string }).table === table;

export class ExecutionService {
  private readonly inflight = new Set<number>();

  constructor(
    private readonly ctx: Ctx,
    private readonly bot: BotController,
  ) {}

  isInflight(tradeId: number): boolean {
    return this.inflight.has(tradeId);
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Persists the decision and (if approved) the trade atomically, then starts live submission. */
  async place(input: PlaceInput): Promise<PlaceResult> {
    const { repos, config, clock } = this.ctx;
    const { mode, round, market, strategy, decision } = input;
    let result: { decision: DecisionRecord; trade: Trade | null };
    try {
      result = await repos.db.tx(async () => {
        const d = await repos.decisions.insert(input.record);
        if (decision.kind !== 'TRADE' || decision.stakeWei === null || decision.direction === null)
          return { decision: d, trade: null };
        const walletId = mode === 'LIVE' ? (await repos.wallets.signer())?.id : null;
        if (mode === 'LIVE' && !walletId) throw new Error('no signer wallet registered');
        const trade = await repos.trades.insert(
          {
            uid: `${mode.toLowerCase()}:${mode === 'LIVE' ? `w${walletId}` : `s${strategy.id}`}:${market.id}:${round.epoch}`,
            mode,
            source: input.source,
            walletId: walletId ?? null,
            marketId: market.id,
            roundId: round.id,
            epoch: round.epoch,
            strategyId: strategy.id,
            decisionId: d.id,
            direction: decision.direction,
            amount: decision.stakeWei,
            entryBullPayout: round.bullPayout,
            entryBearPayout: round.bearPayout,
            placedAt: clock.nowMs(),
            status: mode === 'PAPER' ? 'CONFIRMED' : 'PENDING',
            gasCost: mode === 'PAPER' ? config.simulatedGasPerBetWei : null,
          },
          mode === 'PAPER' ? 'paper fill at decision time (simulated gas)' : 'created; awaiting submission',
        );
        await repos.decisions.attachTrade(d.id, trade.id);
        return { decision: (await repos.decisions.get(d.id))!, trade };
      });
    } catch (err) {
      if (!violatesUniqueOn(err, 'trades')) throw err;
      // Another live bet already exists for this wallet and round (the contract allows only one).
      const d = await repos.decisions.insert({
        ...input.record,
        decision: 'NO_TRADE',
        actualAmount: null,
        reason: 'RISK_REJECTED: SINGLE_BET_PER_ROUND: a live bet for this wallet and round already exists',
      });
      return { decision: d, trade: null, submission: null };
    }

    const trade = result.trade;
    if (!trade) return { ...result, submission: null };
    this.ctx.bus.emit('trade', trade);
    if (mode === 'PAPER') {
      await this.ctx.audit.record({
        component: 'execution',
        severity: 'INFO',
        type: AuditType.BET_CONFIRMED,
        marketId: market.id,
        epoch: round.epoch,
        strategyId: strategy.id,
        tradeId: trade.id,
        message: `PAPER ${trade.direction} ${weiToBnbString(trade.amount)} BNB on round ${round.epoch} (${strategy.slug})`,
      });
      return { ...result, submission: null };
    }
    return { ...result, submission: this.submitLive(trade, round) };
  }

  private async submitLive(trade: Trade, round: StoredRound): Promise<Trade> {
    const { reader, writer, config, repos } = this.ctx;
    this.inflight.add(trade.id);
    try {
      if (!writer) return await this.fail(trade.id, 'NO_SIGNER', 'no signing wallet configured', true);
      const head = await reader.getHead();
      if (head.currentEpoch !== round.epoch) {
        return await this.fail(
          trade.id,
          'STALE_ROUND',
          `contract moved to epoch ${head.currentEpoch} before submission`,
        );
      }
      const secondsToLock = (round.lockTime ?? 0) - head.blockTimestamp;
      if (secondsToLock < config.risk.minSecondsBeforeLock) {
        return await this.fail(
          trade.id,
          'ROUND_LOCKING',
          `only ${secondsToLock}s to lock at submission time`,
        );
      }
      const [ledger, balance, gasPrice, params] = await Promise.all([
        reader.getLedger(round.epoch, writer.address),
        reader.getBalance(writer.address),
        reader.getGasPrice(),
        reader.getParams(),
      ]);
      if (ledger.amount > 0n)
        return await this.fail(
          trade.id,
          'DUPLICATE_BET',
          'wallet already has a bet in this round on-chain',
          false,
        );
      if (params.paused) return await this.fail(trade.id, 'MARKET_PAUSED', 'contract is paused');
      if (trade.amount < params.minBetWei)
        return await this.fail(trade.id, 'BELOW_MIN_BET', 'stake below contract minBetAmount');
      if (config.risk.maxGasPriceWei !== null && gasPrice > config.risk.maxGasPriceWei) {
        return await this.fail(trade.id, 'GAS_PRICE', `gas price ${gasPrice} above limit`);
      }
      if (balance < trade.amount + BET_GAS_ESTIMATE * gasPrice) {
        return await this.fail(trade.id, 'INSUFFICIENT_FUNDS', 'balance below stake + gas');
      }

      const prepared = await writer.prepareBet(trade.direction, round.epoch, trade.amount);
      let current = await repos.trades.transition(
        trade.id,
        'PENDING',
        'SUBMITTING',
        { txHash: prepared.hash, nonce: prepared.nonce, gasPrice: prepared.gasPrice },
        `signed (nonce ${prepared.nonce}, gas limit ${prepared.gasLimit})`,
      );
      this.ctx.log.tx.info(
        { tradeId: trade.id, txHash: prepared.hash, epoch: round.epoch },
        'bet signed; broadcasting',
      );

      try {
        await writer.broadcast(prepared);
      } catch (err) {
        const e = classifyError(err);
        if (e.maybeBroadcast) {
          await this.ctx.audit.record({
            component: 'execution',
            severity: 'WARN',
            type: AuditType.BET_STATUS_UNKNOWN,
            epoch: round.epoch,
            tradeId: trade.id,
            txHash: prepared.hash,
            message: `broadcast outcome unknown (${e.errorClass}: ${e.message}); reconciler will resolve from receipt/ledger`,
          });
          return current;
        }
        return await this.fail(trade.id, e.errorClass, e.message);
      }
      current = await repos.trades.transition(
        trade.id,
        'SUBMITTING',
        'SUBMITTED',
        {},
        'broadcast accepted by RPC',
      );
      this.ctx.bus.emit('trade', current);
      await this.ctx.audit.record({
        component: 'execution',
        severity: 'INFO',
        type: AuditType.BET_SUBMITTED,
        marketId: trade.marketId,
        epoch: round.epoch,
        strategyId: trade.strategyId,
        tradeId: trade.id,
        txHash: prepared.hash,
        message: `LIVE ${trade.direction} ${weiToBnbString(trade.amount)} BNB on round ${round.epoch} submitted`,
      });

      const receipt = await writer.waitForReceipt(prepared.hash, RECEIPT_TIMEOUT_MS);
      if (!receipt) {
        this.ctx.log.tx.warn(
          { tradeId: trade.id, txHash: prepared.hash },
          'receipt not seen within timeout; reconciler will follow up',
        );
        return current;
      }
      return await this.applyReceipt(trade.id, receipt);
    } catch (err) {
      const e = err instanceof ExecutionError ? err : classifyError(err);
      const cur = (await repos.trades.get(trade.id))!;
      if (cur.status === 'SUBMITTING' && e.maybeBroadcast) return cur;
      if (cur.status === 'PENDING' || cur.status === 'SUBMITTING' || cur.status === 'SUBMITTED') {
        if (cur.status === 'SUBMITTED' && e.maybeBroadcast) return cur;
        return await this.fail(trade.id, e.errorClass, e.message);
      }
      return cur;
    } finally {
      this.inflight.delete(trade.id);
    }
  }

  /** Applies a mined receipt. Reverted transactions still record the gas they burned. */
  async applyReceipt(tradeId: number, receipt: TxReceipt): Promise<Trade> {
    const { repos } = this.ctx;
    const cur = (await repos.trades.get(tradeId))!;
    if (cur.status !== 'SUBMITTING' && cur.status !== 'SUBMITTED') return cur;
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    if (receipt.status === 'success') {
      const t = await repos.trades.transition(
        tradeId,
        cur.status,
        'CONFIRMED',
        {
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed,
          gasPrice: receipt.effectiveGasPrice,
          gasCost,
        },
        `mined in block ${receipt.blockNumber}`,
      );
      await this.bot.recordExecutionSuccess();
      await this.ctx.audit.record({
        component: 'execution',
        severity: 'INFO',
        type: AuditType.BET_CONFIRMED,
        marketId: t.marketId,
        epoch: t.epoch,
        strategyId: t.strategyId,
        tradeId: t.id,
        txHash: t.txHash,
        message: `LIVE bet on round ${t.epoch} confirmed (gas ${weiToBnbString(gasCost)} BNB)`,
      });
      this.ctx.bus.emit('trade', t);
      return t;
    }
    const t = await repos.trades.transition(
      tradeId,
      cur.status,
      'FAILED',
      {
        blockNumber: Number(receipt.blockNumber),
        gasUsed: receipt.gasUsed,
        gasPrice: receipt.effectiveGasPrice,
        gasCost,
        error: 'transaction reverted on-chain',
        errorClass: 'CONTRACT_REVERT',
      },
      'reverted on-chain',
    );
    await this.afterFailure(t, 'CONTRACT_REVERT', 'transaction reverted on-chain', true);
    return t;
  }

  /** Marks a trade FAILED from whatever pre-confirmation state it is in. */
  async fail(
    tradeId: number,
    errorClass: string,
    message: string,
    countsTowardBreaker = true,
  ): Promise<Trade> {
    const cur = (await this.ctx.repos.trades.get(tradeId))!;
    if (cur.status !== 'PENDING' && cur.status !== 'SUBMITTING' && cur.status !== 'SUBMITTED') return cur;
    const t = await this.ctx.repos.trades.transition(
      tradeId,
      cur.status,
      'FAILED',
      { error: message, errorClass },
      `failed: ${errorClass}`,
    );
    await this.afterFailure(t, errorClass, message, countsTowardBreaker);
    return t;
  }

  /** Confirms a trade whose bet is visible in the contract ledger although no receipt was obtained. */
  async confirmFromLedger(tradeId: number, detail: string): Promise<Trade> {
    const cur = (await this.ctx.repos.trades.get(tradeId))!;
    if (cur.status === 'CONFIRMED' || cur.status === 'SETTLED' || cur.status === 'FAILED') return cur;
    const t = await this.ctx.repos.trades.transition(tradeId, cur.status, 'CONFIRMED', {}, detail);
    this.ctx.bus.emit('trade', t);
    return t;
  }

  private async afterFailure(
    t: Trade,
    errorClass: string,
    message: string,
    countsTowardBreaker: boolean,
  ): Promise<void> {
    await this.ctx.audit.record({
      component: 'execution',
      severity: 'ERROR',
      type: AuditType.BET_FAILED,
      marketId: t.marketId,
      epoch: t.epoch,
      strategyId: t.strategyId,
      tradeId: t.id,
      txHash: t.txHash,
      message: `LIVE bet on round ${t.epoch} failed: ${errorClass}: ${message}`,
      metadata: { errorClass },
    });
    if (countsTowardBreaker) await this.bot.recordExecutionFailure(`${errorClass}: ${message}`);
    this.ctx.bus.emit('trade', t);
  }

  receiptFor(hash: string) {
    return this.ctx.reader.getReceipt(hash as Hex);
  }
}
