import { useState } from 'react';
import { RoundCards } from '../components/rounds';
import { DecisionTable } from '../components/tables';
import { Card, Dir, EpochLink, ErrorBox, OutcomeTag, PageHead, Seg } from '../components/ui';
import { api } from '../lib/api';
import { bnb, countdown, dateTime, priceDelta, usd } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { useChainNow, useLive } from '../lib/live';
import type { Decision, Direction, Mode, Round, Trade } from '../types';

function ManualOrder() {
  const { market, bot } = useLive();
  const now = useChainNow();
  const [mode, setMode] = useState<Mode>('PAPER');
  const [direction, setDirection] = useState<Direction>('BULL');
  const [amount, setAmount] = useState('0.001');
  const [result, setResult] = useState<{ decision: Decision; trade: Trade | null } | null>(null);
  const action = useAction();
  const next = market?.next;
  const toLock = next?.lockTime && now ? next.lockTime - now : null;
  const submit = () =>
    action.run(async () => {
      const r = await api<{ decision: Decision; trade: Trade | null }>('/api/trades/manual', {
        method: 'POST',
        body: { mode, direction, amountBnb: amount },
      });
      setResult(r);
    });
  return (
    <Card title="Manual order" sub={next ? `round #${next.epoch} · ${countdown(toLock)} to lock` : ''}>
      <div className="stack">
        <div className="secondary small">
          Manual orders go through exactly the same risk checks and execution engine as bot trades. LIVE
          orders additionally require the live-trading gate (environment flag, dashboard arming, signer
          wallet, manual strategy live flag, running bot).
        </div>
        <div className="row">
          <Seg
            value={mode}
            onChange={setMode}
            options={[
              { value: 'PAPER', label: 'Paper' },
              { value: 'LIVE', label: 'Live' },
            ]}
          />
          <Seg
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'BULL', label: '▲ UP' },
              { value: 'BEAR', label: '▼ DOWN' },
            ]}
          />
          <label className="field">
            Stake (BNB)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              style={{ width: 110 }}
            />
          </label>
          <button
            className={mode === 'LIVE' ? 'danger' : 'primary'}
            disabled={action.pending || !next || next.status !== 'OPEN'}
            onClick={() => void submit()}
          >
            Place {mode.toLowerCase()} bet
          </button>
        </div>
        {mode === 'LIVE' && !bot?.liveArmed && (
          <div className="alert">
            Live trading is not armed — the order will be recorded as rejected by the live gate.
          </div>
        )}
        <ErrorBox error={action.error} />
        {result && (
          <div className={`alert ${result.decision.decision === 'TRADE' ? 'info' : ''}`}>
            <strong>{result.decision.decision === 'TRADE' ? 'Order accepted' : 'Order rejected'}</strong> —{' '}
            {result.decision.reason}
            {result.trade && (
              <div className="small">
                Trade #{result.trade.id}: <Dir d={result.trade.direction} /> {bnb(result.trade.amount)} BNB ·
                status {result.trade.status}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function LivePage() {
  const { market } = useLive();
  const now = useChainNow();
  const epoch = market?.next?.epoch;
  const decisions = useApi<{ rows: Decision[] }>(epoch ? `/api/decisions?epoch=${epoch}&limit=50` : null, [
    'decision',
  ]);
  const prevDecisions = useApi<{ rows: Decision[] }>(
    market?.live ? `/api/decisions?epoch=${market.live.epoch}&limit=50` : null,
    ['decision'],
  );
  const recent = useApi<{ rows: Round[] }>('/api/rounds?finalOnly=true&limit=20', ['market'], 30_000);

  return (
    <>
      <PageHead
        title="Live rounds"
        desc="Expired, live, next and upcoming rounds with real-time pools, prices and the active strategy signals."
      />
      <div className="stack">
        {market ? (
          <RoundCards market={market} now={now} />
        ) : (
          <Card>Waiting for the first market snapshot…</Card>
        )}
        <div className="grid cols-2">
          <ManualOrder />
          <Card title="Oracle" sub="Chainlink BNB/USD (resolves every round)">
            <dl className="kv">
              <dt>Price</dt>
              <dd>{usd(market?.oracle?.price, 4)}</dd>
              <dt>Updated</dt>
              <dd>{dateTime(market?.oracle?.updatedAt)}</dd>
              <dt>Oracle round</dt>
              <dd className="mono">{market?.oracle?.roundId ?? '—'}</dd>
              <dt>Oracle contract</dt>
              <dd className="mono">{market?.params.oracleAddress ?? '—'}</dd>
              <dt>Block</dt>
              <dd>{market?.blockNumber ?? '—'}</dd>
              <dt>Chain time</dt>
              <dd>{dateTime(market?.chainTime)}</dd>
            </dl>
          </Card>
        </div>
        <Card
          title={`Signals for the next round${epoch ? ` #${epoch}` : ''}`}
          sub="strategies evaluate inside their entry window before lock"
        >
          <DecisionTable rows={decisions.data?.rows ?? []} showRound={false} />
        </Card>
        {market?.live && (
          <Card title={`Decisions for the live round #${market.live.epoch}`}>
            <DecisionTable rows={prevDecisions.data?.rows ?? []} showRound={false} />
          </Card>
        )}
        <Card title="Recent outcomes" sub="last 20 final rounds">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Closed</th>
                  <th>Result</th>
                  <th className="num">Lock</th>
                  <th className="num">Close</th>
                  <th className="num">Change</th>
                  <th className="num">Pool (BNB)</th>
                  <th className="num">UP ×</th>
                  <th className="num">DOWN ×</th>
                </tr>
              </thead>
              <tbody>
                {(recent.data?.rows ?? []).map((r) => {
                  const d = priceDelta(r.lockPrice, r.closePrice);
                  return (
                    <tr key={r.id}>
                      <td>
                        <EpochLink epoch={r.epoch} />
                      </td>
                      <td className="nowrap">{dateTime(r.closeTime)}</td>
                      <td>
                        <OutcomeTag o={r.outcome} />
                      </td>
                      <td className="num">{usd(r.lockPrice, 3)}</td>
                      <td className="num">{usd(r.closePrice, 3)}</td>
                      <td className={`num ${d.cls}`}>{d.text}</td>
                      <td className="num">{bnb(r.totalAmount, 3)}</td>
                      <td className="num">{r.bullPayout?.toFixed(2) ?? '—'}</td>
                      <td className="num">{r.bearPayout?.toFixed(2) ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
