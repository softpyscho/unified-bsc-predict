import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { bnb, dateTimeMs, pct, timeAgo } from '../lib/format';
import type { Decision, Trade } from '../types';
import { Checks, Dir, EpochLink, JsonView, ModeBadge, Money, Status, TxLink } from './ui';

export function TradeTable({
  rows,
  compact,
  showRunning,
}: {
  rows: Trade[];
  compact?: boolean;
  showRunning?: boolean;
}) {
  const nav = useNavigate();
  if (rows.length === 0)
    return (
      <div className="muted" style={{ padding: '10px 0' }}>
        No trades.
      </div>
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Placed</th>
            <th>Mode</th>
            <th>Round</th>
            <th>Strategy</th>
            <th>Direction</th>
            <th className="num">Stake</th>
            {!compact && <th className="num">Odds at entry</th>}
            {!compact && <th>Tx</th>}
            {!compact && <th className="num">Gas</th>}
            <th>Status</th>
            <th>Result</th>
            {!compact && <th className="num">Payout</th>}
            {!compact && <th className="num">Gross</th>}
            <th className="num">Net P&L</th>
            {showRunning && <th className="num">Cumulative</th>}
            {showRunning && <th className="num">Bankroll after</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => nav(`/trades/${t.id}`)}>
              <td className="nowrap" title={dateTimeMs(t.placedAt)}>
                {compact ? timeAgo(t.placedAt) : dateTimeMs(t.placedAt)}
              </td>
              <td>
                <ModeBadge mode={t.mode} />
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                <EpochLink epoch={t.epoch} />
              </td>
              <td>
                {t.strategySlug ?? (
                  <span className="muted">{t.source === 'IMPORTED' ? 'external' : '—'}</span>
                )}
              </td>
              <td>
                <Dir d={t.direction} />
              </td>
              <td className="num">{bnb(t.amount)}</td>
              {!compact && (
                <td className="num">
                  {t.direction === 'BULL'
                    ? (t.entryBullPayout?.toFixed(2) ?? '—')
                    : (t.entryBearPayout?.toFixed(2) ?? '—')}
                  ×
                </td>
              )}
              {!compact && (
                <td onClick={(e) => e.stopPropagation()}>
                  <TxLink hash={t.txHash} />
                </td>
              )}
              {!compact && <td className="num">{t.gasCost ? bnb(t.gasCost, 6) : '—'}</td>}
              <td>
                <Status s={t.status} />
              </td>
              <td>{t.result ?? <span className="muted">—</span>}</td>
              {!compact && <td className="num">{t.payout ? bnb(t.payout) : '—'}</td>}
              {!compact && (
                <td className="num">
                  <Money wei={t.grossPnl} signed />
                </td>
              )}
              <td className="num">
                <Money wei={t.netPnl} signed />
              </td>
              {showRunning && (
                <td className="num">
                  <Money wei={t.running?.cumulativePnl} signed />
                </td>
              )}
              {showRunning && (
                <td className="num">{t.running?.bankrollAfter ? bnb(t.running.bankrollAfter) : '—'}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const signalText = (d: Decision) =>
  d.signal === 'BUY_UP'
    ? '▲ BUY UP'
    : d.signal === 'BUY_DOWN'
      ? '▼ BUY DOWN'
      : (d.signal ?? (d.error ? 'ERROR' : '—'));

/** "Why did the bot bet or not bet?" — every decision with its reason, inputs and risk checks. */
export function DecisionTable({ rows, showRound = true }: { rows: Decision[]; showRound?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (rows.length === 0)
    return (
      <div className="muted" style={{ padding: '10px 0' }}>
        No decisions recorded.
      </div>
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Decided</th>
            {showRound && <th>Round</th>}
            <th>Strategy</th>
            <th>Mode</th>
            <th>Signal</th>
            <th className="num">Confidence</th>
            <th>Decision</th>
            <th className="num">Stake</th>
            <th>Reason</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <Fragment key={d.id}>
              <tr>
                <td className="nowrap" title={dateTimeMs(d.decidedAt)}>
                  {timeAgo(d.decidedAt)}
                </td>
                {showRound && (
                  <td>
                    <EpochLink epoch={d.epoch} />
                  </td>
                )}
                <td>{d.strategySlug ?? d.strategyId}</td>
                <td>
                  <ModeBadge mode={d.mode} />
                </td>
                <td className="nowrap">{signalText(d)}</td>
                <td className="num">{d.confidence === null ? '—' : pct(d.confidence, 0)}</td>
                <td>
                  <strong className={d.decision === 'TRADE' ? 'pos' : ''}>
                    {d.decision === 'TRADE' ? 'BET' : 'NO BET'}
                  </strong>
                </td>
                <td className="num">
                  {d.actualAmount ? (
                    bnb(d.actualAmount)
                  ) : d.intendedAmount ? (
                    <span className="muted">{bnb(d.intendedAmount)}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="secondary small" style={{ maxWidth: 440 }}>
                  {d.reason}
                </td>
                <td>
                  <button className="small ghost" onClick={() => setOpen(open === d.id ? null : d.id)}>
                    {open === d.id ? 'Hide' : 'Why?'}
                  </button>
                </td>
              </tr>
              {open === d.id && (
                <tr>
                  <td colSpan={showRound ? 10 : 9} style={{ background: 'var(--surface-2)' }}>
                    <div className="grid cols-2">
                      <div className="stack">
                        <div>
                          <h3>Rationale</h3>
                          <div>{d.rationale ?? <span className="muted">—</span>}</div>
                          {d.error && <div className="neg">Error: {d.error}</div>}
                          {d.expectedEdge !== null && (
                            <div className="small secondary">Expected edge: {pct(d.expectedEdge, 2)}</div>
                          )}
                          {d.secondsToLock !== null && (
                            <div className="small secondary">
                              Decided {d.secondsToLock.toFixed(1)}s before lock
                            </div>
                          )}
                        </div>
                        <div>
                          <h3>Risk checks</h3>
                          <Checks checks={d.riskChecks} />
                        </div>
                      </div>
                      <div className="stack">
                        <div>
                          <h3>Indicators</h3>
                          <JsonView value={d.indicators ?? {}} />
                        </div>
                        <div>
                          <h3>Market state & inputs at decision time</h3>
                          <JsonView value={d.inputs ?? {}} />
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
