import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TradeTable } from '../components/tables';
import {
  Card,
  Checks,
  Dir,
  EpochLink,
  ErrorBox,
  ModeBadge,
  Money,
  PageHead,
  Pager,
  Status,
  Tile,
  TxLink,
} from '../components/ui';
import { qs } from '../lib/api';
import { bnb, dateTime, dateTimeMs, pct } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { Decision, Round, StrategyView, Summary, Trade } from '../types';

const LIMIT = 50;
const toMs = (d: string, end = false) =>
  d ? Date.parse(`${d}T00:00:00Z`) + (end ? 86_399_999 : 0) : undefined;

export function TradesPage() {
  const strategies = useApi<StrategyView[]>('/api/strategies');
  const [f, setF] = useState({
    mode: '',
    strategyId: '',
    direction: '',
    result: '',
    status: '',
    source: '',
    from: '',
    to: '',
    minAmount: '',
    maxAmount: '',
    epoch: '',
  });
  const [offset, setOffset] = useState(0);
  const set = (k: keyof typeof f, v: string) => {
    setF({ ...f, [k]: v });
    setOffset(0);
  };
  const path = `/api/trades${qs({
    mode: f.mode,
    strategyId: f.strategyId,
    direction: f.direction,
    result: f.result,
    status: f.status,
    source: f.source,
    from: toMs(f.from),
    to: toMs(f.to, true),
    minAmount: f.minAmount,
    maxAmount: f.maxAmount,
    epoch: f.epoch,
    limit: LIMIT,
    offset,
  })}`;
  const { data, error, loading } = useApi<{
    rows: Trade[];
    total: number;
    summary: Summary;
    bankrollBasis: string | null;
  }>(path, ['trade']);
  const s = data?.summary;
  const sel = (k: keyof typeof f, label: string, options: [string, string][]) => (
    <label className="field">
      {label}
      <select value={f[k]} onChange={(e) => set(k, e.target.value)}>
        <option value="">Any</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <PageHead
        title="Trade ledger"
        desc="Every paper, live and imported trade with execution, settlement and running P&L. Paper and live are labeled on every row."
      />
      <div className="filters">
        {sel('mode', 'Mode', [
          ['PAPER', 'Paper'],
          ['LIVE', 'Live'],
        ])}
        {sel(
          'strategyId',
          'Strategy',
          (strategies.data ?? []).map((x) => [String(x.id), x.name]),
        )}
        {sel('direction', 'Direction', [
          ['BULL', 'UP'],
          ['BEAR', 'DOWN'],
        ])}
        {sel('result', 'Result', [
          ['WON', 'Won'],
          ['LOST', 'Lost'],
          ['REFUNDED', 'Refunded'],
        ])}
        {sel(
          'status',
          'Status',
          ['PENDING', 'SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'SETTLED', 'FAILED'].map((x) => [x, x]),
        )}
        {sel('source', 'Source', [
          ['BOT', 'Bot'],
          ['MANUAL', 'Manual'],
          ['IMPORTED', 'Imported (on-chain)'],
        ])}
        <label className="field">
          From
          <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label className="field">
          Min stake
          <input
            value={f.minAmount}
            onChange={(e) => set('minAmount', e.target.value)}
            style={{ width: 80 }}
          />
        </label>
        <label className="field">
          Max stake
          <input
            value={f.maxAmount}
            onChange={(e) => set('maxAmount', e.target.value)}
            style={{ width: 80 }}
          />
        </label>
        <label className="field">
          Round
          <input value={f.epoch} onChange={(e) => set('epoch', e.target.value)} style={{ width: 90 }} />
        </label>
      </div>
      <ErrorBox error={error} />
      {s && (
        <div className="tiles" style={{ marginBottom: 14 }}>
          <Tile
            label="Trades (filtered)"
            value={data.total.toLocaleString()}
            hint={`${s.settledTrades} settled · ${s.openTrades} open · ${s.failedTrades} failed`}
          />
          <Tile label="Win rate" value={pct(s.winRate)} hint={`${s.wins}W / ${s.losses}L`} />
          <Tile label="Wagered" value={bnb(s.totalWagered)} />
          <Tile label="Net P&L" value={<Money wei={s.netPnl} signed />} hint={`fees ${bnb(s.fees, 5)}`} />
          <Tile label="ROI" value={pct(s.roi, 2)} />
        </div>
      )}
      <Card className={loading ? 'reloading' : ''} sub={data?.bankrollBasis ? '' : undefined}>
        {!f.mode && (
          <div className="alert info small" style={{ marginBottom: 8 }}>
            Showing paper and live trades together. Cumulative and bankroll columns are shown when filtering
            one mode only.
          </div>
        )}
        <TradeTable rows={data?.rows ?? []} showRunning={!!f.mode} />
        {data && <Pager total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}

interface TradeDetail {
  trade: Trade;
  events: { fromStatus: string | null; toStatus: string; at: number; detail: string | null }[];
  decision: Decision | null;
  round: Round | null;
  strategy: StrategyView | null;
}

export function TradeDetailPage() {
  const { id } = useParams();
  const { data, error } = useApi<TradeDetail>(`/api/trades/${id}`, ['trade']);
  const t = data?.trade;
  return (
    <>
      <PageHead title={`Trade #${id}`}>{t && <ModeBadge mode={t.mode} />}</PageHead>
      <ErrorBox error={error} />
      {t && (
        <div className="grid cols-2">
          <Card title="Execution" actions={<Status s={t.status} />}>
            <dl className="kv">
              <dt>Round</dt>
              <dd>
                <EpochLink epoch={t.epoch} />
              </dd>
              <dt>Strategy</dt>
              <dd>
                {data.strategy ? (
                  <Link to={`/strategies/${data.strategy.id}`}>{data.strategy.name}</Link>
                ) : (
                  t.source
                )}
              </dd>
              <dt>Direction</dt>
              <dd>
                <Dir d={t.direction} />
              </dd>
              <dt>Stake</dt>
              <dd>{bnb(t.amount, 6)} BNB</dd>
              <dt>Odds at entry</dt>
              <dd>
                UP {t.entryBullPayout?.toFixed(3) ?? '—'}× · DOWN {t.entryBearPayout?.toFixed(3) ?? '—'}×
              </dd>
              <dt>Placed</dt>
              <dd>{dateTimeMs(t.placedAt)}</dd>
              <dt>Transaction</dt>
              <dd>
                <TxLink hash={t.txHash} />
              </dd>
              <dt>Nonce / block</dt>
              <dd>
                {t.nonce ?? '—'} / {t.blockNumber ?? '—'}
              </dd>
              <dt>Gas used</dt>
              <dd>{t.gasUsed ?? '—'}</dd>
              <dt>Gas cost</dt>
              <dd>
                {t.gasCost ? `${bnb(t.gasCost, 8)} BNB` : t.mode === 'PAPER' ? '—' : 'unknown (imported)'}
              </dd>
              {t.error && (
                <>
                  <dt>Error</dt>
                  <dd className="neg">
                    {t.errorClass}: {t.error}
                  </dd>
                </>
              )}
            </dl>
          </Card>
          <Card title="Settlement">
            <dl className="kv">
              <dt>Result</dt>
              <dd>{t.result ?? '—'}</dd>
              <dt>Settled</dt>
              <dd>{dateTime(t.settledAt)}</dd>
              <dt>Payout</dt>
              <dd>{t.payout ? `${bnb(t.payout, 6)} BNB` : '—'}</dd>
              <dt>Gross P&L</dt>
              <dd>
                <Money wei={t.grossPnl} signed dp={6} />
              </dd>
              <dt>Claim gas</dt>
              <dd>{t.claimGasCost ? bnb(t.claimGasCost, 8) : '—'}</dd>
              <dt>Net P&L</dt>
              <dd>
                <Money wei={t.netPnl} signed dp={6} />
              </dd>
              <dt>Claim</dt>
              <dd>{t.claimStatus}</dd>
            </dl>
          </Card>
          <Card title="State history" sub="append-only">
            <table>
              <tbody>
                {data.events.map((e, i) => (
                  <tr key={i}>
                    <td className="nowrap small">{dateTimeMs(e.at)}</td>
                    <td className="mono small">
                      {e.fromStatus ?? '∅'} → {e.toStatus}
                    </td>
                    <td className="small secondary">{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {data.decision && (
            <Card title="Decision" sub={data.decision.reason}>
              <Checks checks={data.decision.riskChecks} />
            </Card>
          )}
        </div>
      )}
    </>
  );
}
