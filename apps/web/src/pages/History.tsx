import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DecisionTable, TradeTable } from '../components/tables';
import { Card, EpochLink, ErrorBox, JsonView, OutcomeTag, PageHead, Pager, Status } from '../components/ui';
import { qs } from '../lib/api';
import { bnb, dateTime, dateTimeMs, priceDelta, usd } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { AuditEvent, Decision, Market, Round, Trade } from '../types';

const LIMIT = 50;
const toSec = (d: string) => (d ? Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000) : undefined);

export function HistoryPage() {
  const nav = useNavigate();
  const markets = useApi<Market[]>('/api/markets');
  const [f, setF] = useState({ marketId: '', fromEpoch: '', toEpoch: '', from: '', to: '', outcome: '' });
  const [offset, setOffset] = useState(0);
  const set = (k: keyof typeof f, v: string) => {
    setF({ ...f, [k]: v });
    setOffset(0);
  };
  const path = `/api/rounds${qs({
    marketId: f.marketId,
    fromEpoch: f.fromEpoch,
    toEpoch: f.toEpoch,
    from: toSec(f.from),
    to: toSec(f.to) !== undefined ? toSec(f.to)! + 86_399 : undefined,
    outcome: f.outcome,
    limit: LIMIT,
    offset,
  })}`;
  const { data, error, loading } = useApi<{ rows: Round[]; total: number }>(path);
  const market =
    markets.data?.find((m) => String(m.id) === f.marketId) ?? markets.data?.find((m) => m.tradable);

  return (
    <>
      <PageHead
        title="Round history"
        desc="Every stored round: live-synced from chain and imported from the bsc-predict-updater archives."
      />
      <div className="filters">
        <label className="field">
          Market
          <select value={f.marketId} onChange={(e) => set('marketId', e.target.value)}>
            <option value="">Tradable market</option>
            {markets.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          From epoch
          <input
            value={f.fromEpoch}
            onChange={(e) => set('fromEpoch', e.target.value)}
            style={{ width: 100 }}
            inputMode="numeric"
          />
        </label>
        <label className="field">
          To epoch
          <input
            value={f.toEpoch}
            onChange={(e) => set('toEpoch', e.target.value)}
            style={{ width: 100 }}
            inputMode="numeric"
          />
        </label>
        <label className="field">
          From date
          <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="field">
          To date
          <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label className="field">
          Outcome
          <select value={f.outcome} onChange={(e) => set('outcome', e.target.value)}>
            <option value="">Any</option>
            <option value="BULL">UP</option>
            <option value="BEAR">DOWN</option>
            <option value="TIE">Tie</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      <Card className={loading ? 'reloading' : ''}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Round</th>
                <th>{market?.timing === 'BLOCK' ? 'Start block' : 'Start'}</th>
                <th>Status</th>
                <th>Result</th>
                <th className="num">Lock</th>
                <th className="num">Close</th>
                <th className="num">Change</th>
                <th className="num">UP pool</th>
                <th className="num">DOWN pool</th>
                <th className="num">UP ×</th>
                <th className="num">DOWN ×</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r) => {
                const d = priceDelta(r.lockPrice, r.closePrice);
                return (
                  <tr
                    key={r.id}
                    className="clickable"
                    onClick={() => nav(`/rounds/${r.epoch}?marketId=${r.marketId}`)}
                  >
                    <td>#{r.epoch}</td>
                    <td className="nowrap">{r.startTime ? dateTime(r.startTime) : (r.startBlock ?? '—')}</td>
                    <td>
                      <Status s={r.status} />
                    </td>
                    <td>
                      <OutcomeTag o={r.outcome} />
                    </td>
                    <td className="num">{usd(r.lockPrice, 3)}</td>
                    <td className="num">{usd(r.closePrice, 3)}</td>
                    <td className={`num ${d.cls}`}>{d.text}</td>
                    <td className="num">{bnb(r.bullAmount, 3)}</td>
                    <td className="num">{bnb(r.bearAmount, 3)}</td>
                    <td className="num">{r.bullPayout?.toFixed(2) ?? '—'}</td>
                    <td className="num">{r.bearPayout?.toFixed(2) ?? '—'}</td>
                    <td className="small muted">{r.source === 'CHAIN' ? 'chain' : 'archive'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && <Pager total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}

interface RoundDetail {
  market: { id: number; slug: string; treasuryFeeBps: number };
  round: Round;
  decisions: Decision[];
  trades: Trade[];
  corrections: { id: number; previous: unknown; corrected: unknown; source: string; detectedAt: string }[];
  audit: AuditEvent[];
}

export function RoundDetailPage() {
  const { epoch } = useParams();
  const [sp] = useSearchParams();
  const { data, error } = useApi<RoundDetail>(`/api/rounds/${epoch}${qs({ marketId: sp.get('marketId') })}`, [
    'decision',
    'trade',
  ]);
  const r = data?.round;
  const d = r ? priceDelta(r.lockPrice, r.closePrice) : null;
  return (
    <>
      <PageHead title={`Round #${epoch}`} desc={data ? data.market.slug : ''}>
        {r && (
          <>
            <EpochLink epoch={r.epoch - 1} marketId={r.marketId} /> ← →{' '}
            <EpochLink epoch={r.epoch + 1} marketId={r.marketId} />
          </>
        )}
      </PageHead>
      <ErrorBox error={error} />
      {r && d && (
        <div className="stack">
          <div className="grid cols-2">
            <Card title="Round" actions={<Status s={r.status} />}>
              <dl className="kv">
                <dt>Result</dt>
                <dd>
                  <OutcomeTag o={r.outcome} />
                </dd>
                <dt>Start / lock / close</dt>
                <dd>
                  {r.startTime
                    ? `${dateTime(r.startTime)} → ${dateTime(r.lockTime).slice(11)} → ${dateTime(r.closeTime).slice(11)}`
                    : `blocks ${r.startBlock} / ${r.lockBlock} / ${r.closeBlock}`}
                </dd>
                <dt>Start price (prev. lock)</dt>
                <dd>{usd(r.startPrice, 4)}</dd>
                <dt>Lock price</dt>
                <dd>{usd(r.lockPrice, 4)}</dd>
                <dt>Close price</dt>
                <dd>{usd(r.closePrice, 4)}</dd>
                <dt>Change</dt>
                <dd className={d.cls}>{d.text}</dd>
                <dt>Oracle called</dt>
                <dd>{r.oracleCalled ? 'yes' : 'no'}</dd>
                <dt>Final</dt>
                <dd>{r.isFinal ? 'yes' : 'no (may still change)'}</dd>
                <dt>Source</dt>
                <dd>
                  {r.source === 'CHAIN'
                    ? `chain (block ${r.observedAt ? dateTime(r.observedAt) : ''})`
                    : 'bsc-predict-updater archive'}
                </dd>
              </dl>
            </Card>
            <Card
              title="Pool & payouts"
              sub={`treasury fee ${(data.market.treasuryFeeBps / 100).toFixed(2)}%`}
            >
              <dl className="kv">
                <dt>▲ UP amount</dt>
                <dd>{bnb(r.bullAmount, 6)} BNB</dd>
                <dt>▼ DOWN amount</dt>
                <dd>{bnb(r.bearAmount, 6)} BNB</dd>
                <dt>Total</dt>
                <dd>{bnb(r.totalAmount, 6)} BNB</dd>
                <dt>Reward amount</dt>
                <dd>{bnb(r.rewardAmount, 6)} BNB</dd>
                <dt>Reward base (winning side)</dt>
                <dd>{bnb(r.rewardBaseCalAmount, 6)} BNB</dd>
                <dt>UP payout</dt>
                <dd>{r.bullPayout?.toFixed(4) ?? '—'}×</dd>
                <dt>DOWN payout</dt>
                <dd>{r.bearPayout?.toFixed(4) ?? '—'}×</dd>
              </dl>
              {r.extra && <JsonView value={r.extra} />}
            </Card>
          </div>
          <Card
            title="Why did the bot bet or not bet?"
            sub={`${data.decisions.length} strategy decisions for this round`}
          >
            <DecisionTable rows={data.decisions} showRound={false} />
          </Card>
          <Card title="Trades">
            <TradeTable rows={data.trades} />
          </Card>
          {data.corrections.length > 0 && (
            <Card
              title="Data corrections"
              sub="archived values replaced by authoritative chain data (history preserved)"
            >
              {data.corrections.map((c) => (
                <div key={c.id} className="grid cols-2">
                  <div>
                    <h3>Previous ({c.detectedAt})</h3>
                    <JsonView value={c.previous} />
                  </div>
                  <div>
                    <h3>Corrected ({c.source})</h3>
                    <JsonView value={c.corrected} />
                  </div>
                </div>
              ))}
            </Card>
          )}
          <Card title="Audit trail">
            {data.audit.length === 0 ? (
              <div className="muted">No events.</div>
            ) : (
              <table>
                <tbody>
                  {data.audit.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap small">{dateTimeMs(a.ts)}</td>
                      <td className={`sev ${a.severity}`}>{a.severity}</td>
                      <td className="mono small">{a.type}</td>
                      <td className="small">{a.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
