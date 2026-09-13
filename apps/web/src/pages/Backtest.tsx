import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChartCard,
  DrawdownArea,
  Histogram,
  Legend,
  SERIES,
  SignedBars,
  StepLines,
} from '../components/charts';
import { Card, ErrorBox, Money, PageHead, Seg, Status } from '../components/ui';
import { api } from '../lib/api';
import { bnb, bnbNum, dateTime, num, pct, shortDate, signedBnb } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { useLive } from '../lib/live';
import type { Bucket, EquityPoint, Market, PeriodPnl, StrategyView, Summary } from '../types';

const PRESETS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'custom', label: 'Custom' },
];

interface RunRow {
  id: number;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  request: { from: number; to: number; strategies: unknown[] };
  error: string | null;
  progress: number;
  durationMs: number | null;
  createdAt: string;
}

export function BacktestPage() {
  const nav = useNavigate();
  const strategies = useApi<StrategyView[]>('/api/strategies');
  const markets = useApi<Market[]>('/api/markets');
  const runs = useApi<RunRow[]>('/api/backtest', ['backtest']);
  const [preset, setPreset] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [marketId, setMarketId] = useState('');
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [params, setParams] = useState<Record<number, string>>({});
  const [bankroll, setBankroll] = useState('1');
  const [gasBet, setGasBet] = useState('');
  const [gasClaim, setGasClaim] = useState('');
  const [globalLimits, setGlobalLimits] = useState(true);
  const action = useAction();
  const eligible = (strategies.data ?? []).filter((s) => s.plugin && s.plugin.id !== 'manual');

  const submit = () =>
    action.run(async () => {
      const now = Math.floor(Date.now() / 1000);
      const range =
        preset === 'custom'
          ? {
              from: Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000),
              to: Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000),
            }
          : { from: now - Number(preset) * 86_400, to: now };
      const chosen = eligible.filter((s) => selected[s.id]);
      if (chosen.length === 0) throw new Error('select at least one strategy');
      const body = {
        ...range,
        marketId: marketId ? Number(marketId) : undefined,
        startingBankrollBnb: Number(bankroll),
        gasPerBetBnb: gasBet ? Number(gasBet) : undefined,
        gasPerClaimBnb: gasClaim ? Number(gasClaim) : undefined,
        applyGlobalLimits: globalLimits,
        strategies: chosen.map((s) => ({
          strategyId: s.id,
          config: params[s.id] ? { params: JSON.parse(params[s.id]!) as unknown } : undefined,
        })),
      };
      const res = await api<{ id: number }>('/api/backtest', { method: 'POST', body });
      nav(`/backtest/${res.id}`);
    });

  return (
    <>
      <PageHead
        title="Backtesting"
        desc="Replays stored rounds through the exact live decision pipeline, with look-ahead protection and simulated execution."
      />
      <div className="grid cols-2">
        <Card title="New backtest">
          <div className="stack">
            <div className="row">
              <Seg value={preset} onChange={setPreset} options={PRESETS} />
            </div>
            {preset === 'custom' && (
              <div className="row">
                <label className="field">
                  From
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label className="field">
                  To
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
              </div>
            )}
            <label className="field">
              Market
              <select value={marketId} onChange={(e) => setMarketId(e.target.value)}>
                <option value="">Tradable market</option>
                {markets.data
                  ?.filter((m) => m.timing === 'TIMESTAMP')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.stats.final.toLocaleString()} rounds)
                    </option>
                  ))}
              </select>
            </label>
            <div>
              <h3>Strategies (up to 6)</h3>
              {eligible.map((s) => (
                <div key={s.id} className="row" style={{ marginTop: 6 }}>
                  <label className="check" style={{ minWidth: 200 }}>
                    <input
                      type="checkbox"
                      checked={!!selected[s.id]}
                      onChange={(e) => setSelected({ ...selected, [s.id]: e.target.checked })}
                    />
                    {s.name}
                  </label>
                  {selected[s.id] && s.plugin && s.plugin.params.length > 0 && (
                    <input
                      className="mono"
                      style={{ flex: 1 }}
                      placeholder={`params override, e.g. ${JSON.stringify(s.config.params)}`}
                      value={params[s.id] ?? ''}
                      onChange={(e) => setParams({ ...params, [s.id]: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="row">
              <label className="field">
                Starting bankroll (BNB)
                <input
                  value={bankroll}
                  onChange={(e) => setBankroll(e.target.value)}
                  style={{ width: 110 }}
                />
              </label>
              <label className="field">
                Gas per bet (BNB)
                <input
                  value={gasBet}
                  placeholder="server default"
                  onChange={(e) => setGasBet(e.target.value)}
                  style={{ width: 120 }}
                />
              </label>
              <label className="field">
                Gas per claim (BNB)
                <input
                  value={gasClaim}
                  placeholder="server default"
                  onChange={(e) => setGasClaim(e.target.value)}
                  style={{ width: 120 }}
                />
              </label>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={globalLimits}
                onChange={(e) => setGlobalLimits(e.target.checked)}
              />
              Apply the global risk limits from the environment (as the live bot would)
            </label>
            <ErrorBox error={action.error} />
            <div>
              <button className="primary" disabled={action.pending} onClick={() => void submit()}>
                Run backtest
              </button>
            </div>
          </div>
        </Card>
        <Card title="Previous runs">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Range</th>
                <th>Status</th>
                <th className="num">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.data?.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/backtest/${r.id}`)}>
                  <td>#{r.id}</td>
                  <td className="small">
                    {shortDate(r.request.from)} → {shortDate(r.request.to)} · {r.request.strategies.length}{' '}
                    strateg{r.request.strategies.length === 1 ? 'y' : 'ies'}
                  </td>
                  <td>
                    <Status
                      s={r.status === 'DONE' ? 'SETTLED' : r.status === 'RUNNING' ? 'SUBMITTED' : 'FAILED'}
                    />
                  </td>
                  <td className="num">
                    {r.durationMs
                      ? `${(r.durationMs / 1000).toFixed(1)}s`
                      : `${Math.round(r.progress * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

interface ResultRow {
  key: string;
  pluginId: string;
  config: unknown;
  decisions: {
    evaluated: number;
    trades: number;
    noTrades: number;
    errors: number;
    reasons: Record<string, number>;
  };
  summary: Summary;
  byDirection: Record<'BULL' | 'BEAR', Summary>;
  daily: PeriodPnl[];
  weekly: PeriodPnl[];
  monthly: PeriodPnl[];
  equity: EquityPoint[];
  returnsHistogram: Bucket[];
  stakeHistogram: Bucket[];
  capitalUtilization: number | null;
}

interface Run extends RunRow {
  result: {
    market: string;
    from: number;
    to: number;
    rounds: number;
    firstEpoch: number;
    lastEpoch: number;
    startingBankroll: string;
    gasPerBet: string;
    gasPerClaim: string;
    treasuryFeeBps: number;
    appliedGlobalLimits: boolean;
    assumptions: string[];
    results: ResultRow[];
  } | null;
}

export function BacktestResultPage() {
  const { id } = useParams();
  const live = useLive();
  const { data, error } = useApi<Run>(`/api/backtest/${id}`, ['backtest']);
  const [sel, setSel] = useState(0);
  const progress = live.backtest[Number(id)]?.progress ?? data?.progress ?? 0;
  const res = data?.result;
  const series = useMemo(
    () =>
      (res?.results ?? []).map((r, i) => ({
        key: `s${i}`,
        label: r.key,
        points: r.equity.map((p) => ({ x: p.t, y: bnbNum(p.cumulativePnl) })),
      })),
    [res],
  );
  const cur = res?.results[sel];
  return (
    <>
      <PageHead
        title={`Backtest #${id}`}
        desc={
          res
            ? `${res.market} · ${dateTime(res.from)} → ${dateTime(res.to)} · ${res.rounds.toLocaleString()} rounds (#${res.firstEpoch}–#${res.lastEpoch})`
            : undefined
        }
      >
        <Link to="/backtest">← All backtests</Link>
      </PageHead>
      <ErrorBox error={error ?? data?.error} />
      {data?.status === 'RUNNING' && (
        <Card title="Running…">
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            {Math.round(progress * 100)}%
          </div>
        </Card>
      )}
      {res && (
        <div className="stack">
          <Card
            title="Strategy comparison"
            sub={`starting bankroll ${bnb(res.startingBankroll)} BNB · gas ${bnb(res.gasPerBet, 6)}/bet, ${bnb(res.gasPerClaim, 6)}/claim · fee ${(res.treasuryFeeBps / 100).toFixed(2)}%`}
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th className="num">Trades</th>
                    <th className="num">Win rate</th>
                    <th className="num">Net P&L</th>
                    <th className="num">ROI</th>
                    <th className="num">Max drawdown</th>
                    <th className="num">Profit factor</th>
                    <th className="num">Streaks W/L</th>
                    <th className="num">Capital util.</th>
                    <th className="num">Decisions</th>
                  </tr>
                </thead>
                <tbody>
                  {res.results.map((r, i) => (
                    <tr
                      key={r.key}
                      className="clickable"
                      onClick={() => setSel(i)}
                      style={i === sel ? { background: 'var(--accent-wash)' } : undefined}
                    >
                      <td>
                        <span className="dir">
                          <span className="swatch" style={{ background: SERIES[i % SERIES.length] }} />
                          {r.key}
                        </span>
                      </td>
                      <td className="num">{r.summary.settledTrades.toLocaleString()}</td>
                      <td className="num">{pct(r.summary.winRate, 2)}</td>
                      <td className="num">
                        <Money wei={r.summary.netPnl} signed />
                      </td>
                      <td className="num">{pct(r.summary.roi, 2)}</td>
                      <td className="num">
                        {bnb(r.summary.maxDrawdown)} ({pct(r.summary.maxDrawdownPct)})
                      </td>
                      <td className="num">{num(r.summary.profitFactor, 3)}</td>
                      <td className="num">
                        {r.summary.longestWinStreak}/{r.summary.longestLossStreak}
                      </td>
                      <td className="num">{pct(r.capitalUtilization, 2)}</td>
                      <td className="num">
                        {r.decisions.trades.toLocaleString()}/{r.decisions.evaluated.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <ChartCard
            title="Cumulative P&L"
            sub="BNB, per strategy"
            legend={
              <Legend
                items={res.results.map((r, i) => ({ label: r.key, color: SERIES[i % SERIES.length]! }))}
              />
            }
            table={{
              columns: ['Strategy', 'Final P&L', 'Trades'],
              rows: res.results.map((r) => [r.key, signedBnb(r.summary.netPnl), r.summary.settledTrades]),
            }}
          >
            <StepLines series={series} xFormat={shortDate} height={300} />
          </ChartCard>
          {cur && (
            <>
              <div className="row">
                <span className="secondary">Details for</span>
                <Seg
                  value={String(sel)}
                  onChange={(v) => setSel(Number(v))}
                  options={res.results.map((r, i) => ({ value: String(i), label: r.key }))}
                />
              </div>
              <div className="grid cols-2">
                <ChartCard
                  title="Drawdown"
                  sub={cur.key}
                  table={{
                    columns: ['Time', 'Drawdown'],
                    rows: cur.equity.slice(-300).map((p) => [shortDate(p.t), bnb(p.drawdown)]),
                  }}
                >
                  <DrawdownArea
                    points={cur.equity.map((p) => ({ x: p.t, y: bnbNum(p.drawdown) }))}
                    xFormat={shortDate}
                    height={240}
                  />
                </ChartCard>
                <ChartCard
                  title="Monthly P&L"
                  sub={cur.key}
                  table={{
                    columns: ['Month', 'Trades', 'Wins', 'Net'],
                    rows: cur.monthly.map((m) => [m.period, m.trades, m.wins, signedBnb(m.netPnl)]),
                  }}
                >
                  <SignedBars
                    data={cur.monthly.map((m) => ({ label: m.period, value: bnbNum(m.netPnl) }))}
                    height={240}
                  />
                </ChartCard>
                <ChartCard
                  title="Return distribution"
                  sub={cur.key}
                  table={{
                    columns: ['Return', 'Trades'],
                    rows: cur.returnsHistogram.map((b) => [b.label, b.count]),
                  }}
                >
                  <Histogram data={cur.returnsHistogram} />
                </ChartCard>
                <Card title="Why trades were not taken" sub={cur.key}>
                  <table>
                    <tbody>
                      {Object.entries(cur.decisions.reasons).map(([k, n]) => (
                        <tr key={k}>
                          <td className="mono small">{k}</td>
                          <td className="num">{n.toLocaleString()}</td>
                        </tr>
                      ))}
                      <tr>
                        <td className="mono small">strategy errors</td>
                        <td className="num">{cur.decisions.errors}</td>
                      </tr>
                    </tbody>
                  </table>
                  <h3 style={{ marginTop: 10 }}>By direction</h3>
                  <table>
                    <tbody>
                      {(['BULL', 'BEAR'] as const).map((d) => (
                        <tr key={d}>
                          <td>{d === 'BULL' ? '▲ UP' : '▼ DOWN'}</td>
                          <td className="num">{cur.byDirection[d].settledTrades} trades</td>
                          <td className="num">{pct(cur.byDirection[d].winRate)}</td>
                          <td className="num">
                            <Money wei={cur.byDirection[d].netPnl} signed />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
            </>
          )}
          <Card title="Assumptions">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {res.assumptions.map((a) => (
                <li key={a} className="secondary">
                  {a}
                </li>
              ))}
              <li className="secondary">
                {res.appliedGlobalLimits
                  ? 'Global risk limits from the environment were applied.'
                  : 'Global risk limits were NOT applied (strategy limits only).'}
              </li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
