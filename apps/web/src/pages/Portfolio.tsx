import { useMemo, useState } from 'react';
import { ChartCard, DrawdownArea, Histogram, SignedBars, StepLines } from '../components/charts';
import { Card, ErrorBox, Money, PageHead, Seg, Tile } from '../components/ui';
import { qs } from '../lib/api';
import { bnb, bnbNum, num, pct, shortDate, signedBnb } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { Account, PortfolioReport, StrategyView, Summary } from '../types';

type ModeSel = 'PAPER' | 'LIVE' | 'ALL';
const RANGES: { value: string; label: string; days: number | null }[] = [
  { value: 'all', label: 'All time', days: null },
  { value: '7', label: '7 days', days: 7 },
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
];

export function SummaryTiles({
  s,
  account,
  utilization,
}: {
  s: Summary;
  account?: Account | null;
  utilization?: number | null;
}) {
  return (
    <div className="tiles">
      {account && (
        <Tile
          label="Bankroll"
          value={account.balance === null ? '—' : bnb(account.balance)}
          hint={
            account.bankrollBasis === 'IMPLIED'
              ? 'wallet + open + claimable'
              : account.bankrollBasis === 'CONFIGURED'
                ? `started at ${bnb(account.startingBankroll)}`
                : 'unknown'
          }
        />
      )}
      {account && (
        <Tile label="Available" value={bnb(account.available)} hint={`exposure ${bnb(account.exposure)}`} />
      )}
      <Tile
        label="Realized P&L"
        value={<Money wei={s.netPnl} signed />}
        hint={`gross ${signedBnb(s.grossPnl)} · fees ${bnb(s.fees, 5)}`}
      />
      <Tile label="ROI" value={pct(s.roi, 2)} hint="net P&L / wagered" />
      <Tile label="Total wagered" value={bnb(s.totalWagered)} hint={`${s.settledTrades} settled trades`} />
      <Tile label="Total payouts" value={bnb(s.totalPayout)} />
      <Tile label="Win rate" value={pct(s.winRate)} hint={`${s.wins} wins · ${s.refunds} refunds`} />
      <Tile label="Loss rate" value={pct(s.lossRate)} hint={`${s.losses} losses`} />
      <Tile label="Average win" value={<Money wei={s.avgWin} signed />} />
      <Tile label="Average loss" value={<Money wei={s.avgLoss} signed />} />
      <Tile label="Profit factor" value={num(s.profitFactor, 3)} hint="gross wins / gross losses" />
      <Tile
        label="Longest streaks"
        value={`${s.longestWinStreak}W / ${s.longestLossStreak}L`}
        hint={s.currentStreak.kind ? `current ${s.currentStreak.length} ${s.currentStreak.kind}` : ''}
      />
      <Tile label="Average stake" value={bnb(s.avgStake)} hint={`max ${bnb(s.maxStake)}`} />
      <Tile
        label="Max drawdown"
        value={bnb(s.maxDrawdown)}
        hint={s.maxDrawdownPct === null ? 'absolute' : pct(s.maxDrawdownPct)}
      />
      {utilization !== undefined && (
        <Tile label="Capital utilization" value={pct(utilization, 2)} hint="avg stake / bankroll" />
      )}
    </div>
  );
}

const xDate = (t: number) => shortDate(t);

export function PortfolioCharts({ report }: { report: PortfolioReport }) {
  const [curve, setCurve] = useState<'pnl' | 'bankroll'>('pnl');
  const pnlSeries = useMemo(
    () => [
      {
        key: 'v',
        label: curve === 'pnl' ? 'Cumulative P&L' : 'Bankroll',
        points: report.equity.map((p) => ({
          x: p.t,
          y: bnbNum(curve === 'pnl' ? p.cumulativePnl : (p.bankroll ?? '0')),
        })),
      },
    ],
    [report, curve],
  );
  const dd = useMemo(() => report.equity.map((p) => ({ x: p.t, y: bnbNum(p.drawdown) })), [report]);
  const daily = report.daily.slice(-90);
  const strategies = Object.entries(report.byStrategy);
  return (
    <>
      <div className="grid cols-2">
        <ChartCard
          title={curve === 'pnl' ? 'Cumulative P&L' : 'Bankroll curve'}
          sub="BNB, realized"
          table={{
            columns: ['Settled', 'Round', 'Trade net', 'Cumulative', 'Bankroll'],
            rows: report.equity
              .slice(-300)
              .map((p) => [
                shortDate(p.t),
                p.epoch,
                signedBnb(p.net),
                signedBnb(p.cumulativePnl),
                p.bankroll ? bnb(p.bankroll) : '—',
              ]),
          }}
        >
          {report.startingBankroll && (
            <div style={{ marginBottom: 6 }}>
              <Seg
                value={curve}
                onChange={setCurve}
                options={[
                  { value: 'pnl', label: 'P&L' },
                  { value: 'bankroll', label: 'Bankroll' },
                ]}
              />
            </div>
          )}
          <StepLines series={pnlSeries} xFormat={xDate} zeroLine={curve === 'pnl'} />
        </ChartCard>
        <ChartCard
          title="Drawdown"
          sub="BNB below the running peak"
          table={{
            columns: ['Settled', 'Drawdown'],
            rows: report.equity.slice(-300).map((p) => [shortDate(p.t), bnb(p.drawdown)]),
          }}
        >
          <DrawdownArea points={dd} xFormat={xDate} height={260} />
        </ChartCard>
      </div>
      <ChartCard
        title="Daily P&L"
        sub={`last ${daily.length} days with activity · blue gain / red loss`}
        table={{
          columns: ['Day', 'Trades', 'Wins', 'Net P&L'],
          rows: [...report.daily].reverse().map((d) => [d.period, d.trades, d.wins, signedBnb(d.netPnl)]),
        }}
      >
        <SignedBars data={daily.map((d) => ({ label: d.period.slice(5), value: bnbNum(d.netPnl) }))} />
      </ChartCard>
      <div className="grid cols-2">
        <ChartCard
          title="Strategy comparison"
          sub="net P&L"
          table={{
            columns: ['Strategy', 'Trades', 'Win rate', 'Net P&L', 'ROI', 'Max DD'],
            rows: strategies.map(([k, s]) => [
              k,
              s.settledTrades,
              pct(s.winRate),
              signedBnb(s.netPnl),
              pct(s.roi, 2),
              bnb(s.maxDrawdown),
            ]),
          }}
        >
          <SignedBars data={strategies.map(([k, s]) => ({ label: k, value: bnbNum(s.netPnl) }))} />
        </ChartCard>
        <Card title="Markets & directions">
          <table>
            <thead>
              <tr>
                <th>Segment</th>
                <th className="num">Trades</th>
                <th className="num">Win rate</th>
                <th className="num">Net P&L</th>
                <th className="num">ROI</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...Object.entries(report.byMarket).map(([k, s]) => [`market: ${k}`, s] as const),
                ['▲ UP bets', report.byDirection.BULL] as const,
                ['▼ DOWN bets', report.byDirection.BEAR] as const,
              ].map(([k, s]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="num">{s.settledTrades}</td>
                  <td className="num">{pct(s.winRate)}</td>
                  <td className="num">
                    <Money wei={s.netPnl} signed />
                  </td>
                  <td className="num">{pct(s.roi, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <div className="grid cols-2">
        <ChartCard
          title="Win/loss distribution"
          sub="net return per settled trade"
          table={{
            columns: ['Return', 'Trades'],
            rows: report.returnsHistogram.map((b) => [b.label, b.count]),
          }}
        >
          <Histogram data={report.returnsHistogram} />
        </ChartCard>
        <ChartCard
          title="Bet-size distribution"
          sub="stake in BNB"
          table={{
            columns: ['Stake (BNB)', 'Trades'],
            rows: report.stakeHistogram.map((b) => [b.label, b.count]),
          }}
        >
          <Histogram data={report.stakeHistogram} />
        </ChartCard>
      </div>
      <div className="grid cols-2">
        <PeriodTable title="Weekly P&L" rows={report.weekly} />
        <PeriodTable title="Monthly P&L" rows={report.monthly} />
      </div>
    </>
  );
}

function PeriodTable({ title, rows }: { title: string; rows: PortfolioReport['weekly'] }) {
  return (
    <Card title={title}>
      <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th className="num">Trades</th>
              <th className="num">Wins</th>
              <th className="num">Net P&L</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.period}>
                <td>{r.period}</td>
                <td className="num">{r.trades}</td>
                <td className="num">{r.wins}</td>
                <td className="num">
                  <Money wei={r.netPnl} signed />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function PortfolioPage() {
  const [mode, setMode] = useState<ModeSel>('PAPER');
  const [range, setRange] = useState('all');
  const [strategyId, setStrategyId] = useState('');
  const strategies = useApi<StrategyView[]>('/api/strategies');
  const days = RANGES.find((r) => r.value === range)?.days ?? null;
  const from = useMemo(() => (days ? Date.now() - days * 86_400_000 : undefined), [days]);
  const { data, error, loading } = useApi<{
    mode: ModeSel;
    account: Account | null;
    report: PortfolioReport;
    mixedModes: boolean;
  }>(`/api/portfolio${qs({ mode, strategyId, from })}`, ['trade', 'portfolio']);
  return (
    <>
      <PageHead
        title="Portfolio"
        desc="Performance analytics computed from the trade ledger (exact wei arithmetic)."
      />
      <div className="filters">
        <Seg
          value={mode}
          onChange={setMode}
          options={[
            { value: 'PAPER', label: 'Paper' },
            { value: 'LIVE', label: 'Live' },
            { value: 'ALL', label: 'Combined' },
          ]}
        />
        <Seg value={range} onChange={setRange} options={RANGES} />
        <label className="field">
          Strategy
          <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
            <option value="">All strategies</option>
            {strategies.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      {data?.mixedModes && (
        <div className="alert" style={{ marginBottom: 14 }}>
          Combined view: paper (simulated) and live (real funds) trades are aggregated. Use the Paper or Live
          tabs for account-level bankroll figures.
        </div>
      )}
      {data && (
        <div className={`stack ${loading ? 'reloading' : ''}`}>
          <SummaryTiles
            s={data.report.summary}
            account={data.account}
            utilization={data.report.capitalUtilization}
          />
          {(strategyId || days) && (
            <div className="muted small">
              Filtered view: the bankroll curve is only shown for the unfiltered account.
            </div>
          )}
          <PortfolioCharts report={data.report} />
        </div>
      )}
    </>
  );
}
