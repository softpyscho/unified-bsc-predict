import { Link } from 'react-router-dom';
import { RoundCards } from '../components/rounds';
import { DecisionTable, TradeTable } from '../components/tables';
import { Card, ErrorBox, ModeBadge, Money, PageHead, Status, Tile } from '../components/ui';
import { bnb, dateTimeMs, pct } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useChainNow, useLive } from '../lib/live';
import type { AuditEvent, BotView, Decision, MarketState, Mode, ModeOverview, Trade } from '../types';

interface Overview {
  market: MarketState | null;
  bot: BotView;
  paper: ModeOverview;
  live: ModeOverview;
  latestTrades: Trade[];
  latestDecisions: Decision[];
  alerts: AuditEvent[];
  activeStrategies: { id: number; slug: string; name: string; paper: boolean; live: boolean }[];
}

function ModePanel({ mode, o }: { mode: Mode; o: ModeOverview }) {
  const s = o.summary;
  return (
    <Card
      title={<>{mode === 'PAPER' ? 'Paper account' : 'Live account'}</>}
      actions={<ModeBadge mode={mode} />}
    >
      <div className="tiles">
        <Tile
          label="Bankroll"
          value={o.account.balance === null ? '—' : `${bnb(o.account.balance, 4)}`}
          hint={
            o.account.bankrollBasis === 'IMPLIED'
              ? 'wallet balance'
              : o.account.bankrollBasis === 'CONFIGURED'
                ? 'BNB (simulated)'
                : 'no wallet'
          }
        />
        <Tile
          label="Today's P&L"
          value={<Money wei={o.todayPnl} signed />}
          hint={`${o.todayTrades} settled today`}
        />
        <Tile label="Overall P&L" value={<Money wei={s.netPnl} signed />} hint={`ROI ${pct(s.roi, 2)}`} />
        <Tile
          label="Win rate"
          value={pct(s.winRate)}
          hint={`${s.wins}W / ${s.losses}L / ${s.refunds} refunded`}
        />
        <Tile label="Exposure" value={bnb(o.account.exposure)} hint={`${s.openTrades} open`} />
        <Tile
          label="Max drawdown"
          value={bnb(s.maxDrawdown)}
          hint={s.maxDrawdownPct === null ? '' : pct(s.maxDrawdownPct)}
        />
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const { data, error } = useApi<Overview>(
    '/api/overview',
    ['trade', 'decision', 'bot', 'audit', 'portfolio'],
    30_000,
  );
  const live = useLive();
  const now = useChainNow();
  const market = live.market ?? data?.market ?? null;
  const bot = live.bot ?? data?.bot;

  return (
    <>
      <PageHead
        title="Dashboard"
        desc="Live market, bot state and performance across paper and live trading."
      />
      <ErrorBox error={error} />
      <div className="stack">
        {market ? (
          <RoundCards market={market} now={now} />
        ) : (
          <Card>Waiting for the first market snapshot…</Card>
        )}
        {data && (
          <div className="grid cols-2">
            <ModePanel mode="PAPER" o={data.paper} />
            <ModePanel mode="LIVE" o={data.live} />
          </div>
        )}
        <div className="grid cols-2">
          <Card title="Bot" actions={<Link to="/bot">Control center →</Link>}>
            {bot && (
              <div className="stack">
                <div className="row">
                  <Status s={bot.status} />
                  <Status s={bot.phase} />
                  {bot.liveTradingEnabled ? (
                    bot.liveArmed ? (
                      <ModeBadge mode="LIVE" />
                    ) : (
                      <span className="badge">live disarmed</span>
                    )
                  ) : (
                    <span className="badge">live disabled (env)</span>
                  )}
                  {bot.consecutiveFailures > 0 && (
                    <span className="badge">{bot.consecutiveFailures} execution failures</span>
                  )}
                </div>
                <div className="secondary small">{bot.statusReason}</div>
                <div>
                  <h3>Active strategies</h3>
                  {data?.activeStrategies.length ? (
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {data.activeStrategies.map((s) => (
                        <li key={s.id}>
                          <Link to={`/strategies/${s.id}`}>{s.name}</Link>{' '}
                          {s.paper && <ModeBadge mode="PAPER" />} {s.live && <ModeBadge mode="LIVE" />}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="muted">No strategy enabled. Enable one on the Strategies page.</div>
                  )}
                </div>
              </div>
            )}
          </Card>
          <Card title="Alerts" sub="warnings and errors" actions={<Link to="/logs">All logs →</Link>}>
            {data?.alerts.length ? (
              <div className="stack" style={{ gap: 6 }}>
                {data.alerts.map((a) => (
                  <div key={a.id} className={`alert ${a.severity === 'WARN' ? '' : 'error'}`}>
                    <span className={`sev ${a.severity}`}>{a.severity}</span>{' '}
                    <span className="mono small">{a.type}</span> ·{' '}
                    <span className="muted small">{dateTimeMs(a.ts)}</span>
                    <div className="small">{a.message}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">No warnings or errors.</div>
            )}
          </Card>
        </div>
        <Card title="Latest trades" actions={<Link to="/trades">All trades →</Link>}>
          <TradeTable rows={data?.latestTrades ?? []} compact />
        </Card>
        <Card title="Recent signals" sub="every decision, including when the bot did not bet">
          <DecisionTable rows={data?.latestDecisions ?? []} />
        </Card>
      </div>
    </>
  );
}
