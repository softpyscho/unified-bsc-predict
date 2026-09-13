import { useState } from 'react';
import { TradeTable } from '../components/tables';
import { Addr, Card, Confirm, ErrorBox, ModeBadge, PageHead, Status, Tile } from '../components/ui';
import { api } from '../lib/api';
import { countdown, dateTimeMs } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { useLive } from '../lib/live';
import type { AuditEvent, BotView, Decision, Trade } from '../types';

interface BotStatus extends BotView {
  inflightExecutions: number;
  currentEpoch: number | null;
  secondsToLock: number | null;
  marketStale: boolean;
  lastDecision: Decision | null;
  lastTrade: Trade | null;
  recentErrors: AuditEvent[];
  openLiveTrades: Trade[];
}

type Dialog = 'emergency' | 'arm' | 'reset' | null;

export function BotPage() {
  const live = useLive();
  const { data, error, reload } = useApi<BotStatus>('/api/bot/status', ['bot', 'trade', 'decision'], 5_000);
  const bot = live.bot ?? data;
  const action = useAction();
  const [dialog, setDialog] = useState<Dialog>(null);
  const call = (path: string, body: Record<string, unknown> = {}) =>
    action.run(async () => {
      await api(path, { method: 'POST', body });
      setDialog(null);
      reload();
    });
  if (!bot) return <ErrorBox error={error} />;
  const running = bot.status === 'RUNNING';
  const emergency = bot.status === 'EMERGENCY_STOPPED';

  return (
    <>
      <PageHead title="Bot control center" desc="Lifecycle, live-trading gate and execution health." />
      <ErrorBox error={error ?? action.error} />
      <div className="stack">
        <div className="tiles">
          <Tile label="Status" value={<Status s={bot.status} />} hint={bot.statusReason ?? ''} />
          <Tile
            label="Phase"
            value={<Status s={bot.phase} />}
            hint={
              bot.phase === 'RECOVERING' ? 'startup reconciliation in progress; trading blocked' : 'ready'
            }
          />
          <Tile label="Can trade" value={bot.canTrade ? 'yes' : 'no'} />
          <Tile
            label="Live trading"
            value={bot.liveArmed ? <ModeBadge mode="LIVE" /> : 'disarmed'}
            hint={bot.liveTradingEnabled ? 'enabled in environment' : 'disabled in environment'}
          />
          <Tile
            label="Execution failures"
            value={`${bot.consecutiveFailures} / ${bot.maxExecutionFailures}`}
            hint="circuit breaker pauses the bot at the limit"
          />
          <Tile
            label="Next round"
            value={data?.currentEpoch ? `#${data.currentEpoch}` : '—'}
            hint={
              data?.secondsToLock !== null && data?.secondsToLock !== undefined
                ? `locks in ${countdown(data.secondsToLock)}`
                : ''
            }
          />
        </div>
        <div className="grid cols-2">
          <Card title="Controls">
            <div className="row">
              <button
                className="primary"
                disabled={running || emergency || action.pending}
                onClick={() => void call('/api/bot/start')}
              >
                Start
              </button>
              <button disabled={!running || action.pending} onClick={() => void call('/api/bot/pause')}>
                Pause
              </button>
              <button
                disabled={bot.status !== 'PAUSED' || action.pending}
                onClick={() => void call('/api/bot/resume')}
              >
                Resume
              </button>
              <button
                disabled={bot.status === 'STOPPED' || emergency || action.pending}
                onClick={() => void call('/api/bot/stop')}
              >
                Stop
              </button>
              <button className="danger" disabled={emergency} onClick={() => setDialog('emergency')}>
                Emergency stop
              </button>
              {emergency && <button onClick={() => setDialog('reset')}>Reset emergency stop</button>}
            </div>
            <p className="secondary small">
              Stop disarms live trading. Emergency stop immediately blocks all new executions and requires an
              explicit reset. Transactions already broadcast cannot be recalled; the reconciler will still
              track them.
            </p>
          </Card>
          <Card title="Live-trading gate" sub="all conditions must hold for a real transaction">
            <div className="checks">
              {[
                ['LIVE_TRADING_ENABLED (env)', bot.liveTradingEnabled],
                ['Signer wallet configured', bot.hasSigner],
                ['Armed in dashboard', bot.liveArmed],
                ['Bot running & ready', bot.canTrade],
                ['Circuit breaker clear', bot.consecutiveFailures < bot.maxExecutionFailures],
              ].map(([k, ok]) => (
                <div className="chk" key={String(k)}>
                  <span className={ok ? 'ok' : 'no'}>{ok ? '✓' : '✗'}</span>
                  <span>{k}</span>
                  <span />
                </div>
              ))}
              <div className="small secondary" style={{ marginTop: 4 }}>
                Plus per trade: strategy enabled with its live flag, risk limits, round still open, sufficient
                balance, gas price limit. Wallet: <Addr a={bot.walletAddress} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              {bot.liveArmed ? (
                <button onClick={() => void call('/api/bot/live/disarm')}>Disarm live trading</button>
              ) : (
                <button
                  className="danger"
                  disabled={!bot.liveTradingEnabled || !bot.hasSigner || emergency}
                  onClick={() => setDialog('arm')}
                >
                  Arm live trading…
                </button>
              )}
            </div>
          </Card>
        </div>
        <div className="grid cols-2">
          <Card title="Last signal">
            {data?.lastDecision ? (
              <div>
                Round #{data.lastDecision.epoch} · <ModeBadge mode={data.lastDecision.mode} /> ·{' '}
                {data.lastDecision.signal ?? 'no signal'} →{' '}
                <strong>{data.lastDecision.decision === 'TRADE' ? 'BET' : 'NO BET'}</strong>
                <div className="secondary small">{data.lastDecision.reason}</div>
                <div className="muted small">{dateTimeMs(data.lastDecision.decidedAt)}</div>
              </div>
            ) : (
              <div className="muted">No decisions yet.</div>
            )}
          </Card>
          <Card title="Recent errors">
            {data?.recentErrors.length ? (
              data.recentErrors.map((e) => (
                <div key={e.id} className="small" style={{ marginBottom: 6 }}>
                  <span className="mono">{e.type}</span> · <span className="muted">{dateTimeMs(e.ts)}</span>
                  <div>{e.message}</div>
                </div>
              ))
            ) : (
              <div className="muted">None.</div>
            )}
          </Card>
        </div>
        <Card
          title="Live transactions in flight"
          sub={`${data?.inflightExecutions ?? 0} executing in this process`}
        >
          <TradeTable rows={data?.openLiveTrades ?? []} />
        </Card>
        {data?.lastTrade && (
          <Card title="Last trade">
            <TradeTable rows={[data.lastTrade]} />
          </Card>
        )}
      </div>
      {dialog === 'emergency' && (
        <Confirm
          title="Emergency stop"
          danger
          body="All new executions are blocked immediately and live trading is disarmed. The bot must be explicitly reset afterwards."
          confirmLabel="Emergency stop"
          onClose={() => setDialog(null)}
          onConfirm={() => void call('/api/bot/emergency-stop', { reason: 'dashboard' })}
        />
      )}
      {dialog === 'reset' && (
        <Confirm
          title="Reset emergency stop"
          body="The bot returns to STOPPED. Live trading stays disarmed until you arm it again."
          confirmLabel="Reset"
          onClose={() => setDialog(null)}
          onConfirm={() => void call('/api/bot/reset', { acknowledge: true })}
        />
      )}
      {dialog === 'arm' && (
        <Confirm
          title="Arm live trading"
          danger
          phrase="ENABLE LIVE TRADING"
          body={
            <>
              Strategies with their <strong>Live</strong> flag enabled will sign and broadcast real BNB
              transactions from <Addr a={bot.walletAddress} /> within the global and strategy risk limits.
              Arming is cleared on restart unless BOT_AUTO_RESUME_LIVE=true.
            </>
          }
          confirmLabel="Arm live trading"
          onClose={() => setDialog(null)}
          onConfirm={(typed) => void call('/api/bot/live/arm', { confirmation: typed })}
        />
      )}
    </>
  );
}
