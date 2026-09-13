import type { ParamSpec, StrategyConfig } from '@bsc/core';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DecisionTable } from '../components/tables';
import { Card, ErrorBox, ModeBadge, Money, PageHead, Seg } from '../components/ui';
import { api } from '../lib/api';
import { bnb, pct } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import type { Decision, Mode, PortfolioReport, StrategyView, Summary } from '../types';
import { PortfolioCharts, SummaryTiles } from './Portfolio';

function PerfRow({ mode, s }: { mode: Mode; s: Summary }) {
  return (
    <tr>
      <td>
        <ModeBadge mode={mode} />
      </td>
      <td className="num">{s.settledTrades}</td>
      <td className="num">{pct(s.winRate)}</td>
      <td className="num">
        <Money wei={s.netPnl} signed />
      </td>
      <td className="num">{bnb(s.maxDrawdown)}</td>
    </tr>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function StrategiesPage() {
  const { data, error, reload } = useApi<StrategyView[]>('/api/strategies', ['trade', 'decision']);
  const action = useAction();
  const patch = (id: number, body: Record<string, unknown>) =>
    action.run(async () => {
      await api(`/api/strategies/${id}`, { method: 'PATCH', body });
      reload();
    });
  return (
    <>
      <PageHead
        title="Strategies"
        desc="Strategy plugins run through the same signal → risk → execution pipeline in backtest, paper and live modes."
      />
      <ErrorBox error={error ?? action.error} />
      <div className="grid cols-2">
        {data?.map((s) => (
          <Card
            key={s.id}
            title={
              <>
                <Link to={`/strategies/${s.id}`}>{s.name}</Link> <span className="sub">v{s.version}</span>
              </>
            }
            actions={<Link to={`/strategies/${s.id}`}>Configure →</Link>}
          >
            <p className="secondary small" style={{ marginTop: 0 }}>
              {s.description}
            </p>
            <div className="row" style={{ marginBottom: 10, gap: 16 }}>
              <Toggle
                label="Enabled"
                checked={s.enabled}
                onChange={(v) => void patch(s.id, { enabled: v })}
              />
              <Toggle
                label="Paper"
                checked={s.paperTradingEnabled}
                onChange={(v) => void patch(s.id, { paperTradingEnabled: v })}
              />
              <Toggle
                label="Live"
                checked={s.liveTradingEnabled}
                onChange={(v) => {
                  if (
                    !v ||
                    window.confirm(`Allow "${s.name}" to place real-money bets once live trading is armed?`)
                  )
                    void patch(s.id, { liveTradingEnabled: v });
                }}
              />
            </div>
            <table>
              <thead>
                <tr>
                  <th>Mode</th>
                  <th className="num">Trades</th>
                  <th className="num">Win rate</th>
                  <th className="num">Net P&L</th>
                  <th className="num">Max DD</th>
                </tr>
              </thead>
              <tbody>
                <PerfRow mode="PAPER" s={s.performance.PAPER} />
                <PerfRow mode="LIVE" s={s.performance.LIVE} />
              </tbody>
            </table>
            <div className="muted small" style={{ marginTop: 6 }}>
              {s.decisions.total.toLocaleString()} decisions · {s.decisions.trades.toLocaleString()} bets ·
              sizing {s.config.sizing?.mode}{' '}
              {s.config.sizing?.mode === 'FIXED' ? `${s.config.sizing.fixedBnb} BNB` : ''}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function ParamInput({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (spec.type === 'boolean')
    return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  if (spec.type === 'enum')
    return (
      <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {spec.options?.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  return (
    <input
      type="number"
      value={String(value ?? '')}
      min={spec.min}
      max={spec.max}
      step={spec.step ?? (spec.type === 'integer' ? 1 : 'any')}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      style={{ width: 110 }}
    />
  );
}

const LIMITS: [keyof StrategyConfig['limits'], string][] = [
  ['maxStakeBnb', 'Max stake (BNB)'],
  ['maxBankrollFraction', 'Max bankroll fraction (0–1)'],
  ['maxDailyLossBnb', 'Daily loss limit (BNB)'],
  ['maxConsecutiveLosses', 'Max consecutive losses'],
  ['cooldownRounds', 'Cooldown (rounds)'],
  ['maxExposureBnb', 'Max exposure (BNB)'],
  ['stopLossBnb', 'Stop-loss (BNB)'],
  ['minConfidence', 'Min confidence (0–1)'],
  ['minExpectedEdge', 'Min expected edge (e.g. 0.02)'],
];

export function StrategyDetailPage() {
  const { id } = useParams();
  const { data, error, reload } = useApi<StrategyView & { recentDecisions: Decision[] }>(
    `/api/strategies/${id}`,
    ['decision'],
  );
  const perf = useApi<Record<Mode, PortfolioReport>>(`/api/strategies/${id}/performance`, ['trade']);
  const [cfg, setCfg] = useState<StrategyConfig | null>(null);
  const [mode, setMode] = useState<Mode>('PAPER');
  const action = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data && !cfg) setCfg(data.config);
  }, [data, cfg]);

  const save = () =>
    action.run(async () => {
      await api(`/api/strategies/${id}`, { method: 'PATCH', body: { config: cfg } });
      setSaved(true);
      reload();
    });
  const upd = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) => {
    setSaved(false);
    setCfg((c) => (c ? { ...c, [k]: v } : c));
  };

  return (
    <>
      <PageHead title={data?.name ?? 'Strategy'} desc={data?.description} />
      <ErrorBox error={error} />
      {data && cfg && (
        <div className="stack">
          <Card
            title="Configuration"
            sub="changes apply from the next round; no code change or restart needed"
            actions={
              <button className="primary" disabled={action.pending} onClick={() => void save()}>
                Save
              </button>
            }
          >
            <ErrorBox error={action.error} />
            {saved && (
              <div className="alert info" style={{ marginBottom: 8 }}>
                Saved.
              </div>
            )}
            <div className="grid cols-3">
              <div className="stack" style={{ gap: 8 }}>
                <h3>Parameters</h3>
                {(data.plugin?.params ?? []).map((p) => (
                  <label key={p.key} className="field" title={p.description}>
                    {p.label}
                    <ParamInput
                      spec={p}
                      value={cfg.params[p.key]}
                      onChange={(v) => upd('params', { ...cfg.params, [p.key]: v as never })}
                    />
                    <span className="muted">{p.description}</span>
                  </label>
                ))}
                {(data.plugin?.params.length ?? 0) === 0 && <span className="muted">No parameters.</span>}
                <label className="field">
                  Directions
                  <select
                    value={cfg.directions}
                    onChange={(e) => upd('directions', e.target.value as StrategyConfig['directions'])}
                  >
                    <option value="BOTH">Both</option>
                    <option value="BULL_ONLY">UP only</option>
                    <option value="BEAR_ONLY">DOWN only</option>
                  </select>
                </label>
              </div>
              <div className="stack" style={{ gap: 8 }}>
                <h3>Timing & sizing</h3>
                <label className="field">
                  Evaluate from (seconds before lock)
                  <input
                    type="number"
                    value={cfg.timing.entrySecondsBeforeLock}
                    onChange={(e) =>
                      upd('timing', { ...cfg.timing, entrySecondsBeforeLock: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="field">
                  Latest submission (seconds before lock)
                  <input
                    type="number"
                    value={cfg.timing.minSecondsBeforeLock}
                    onChange={(e) =>
                      upd('timing', { ...cfg.timing, minSecondsBeforeLock: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="field">
                  Sizing mode
                  <select
                    value={cfg.sizing.mode}
                    onChange={(e) =>
                      upd('sizing', {
                        ...cfg.sizing,
                        mode: e.target.value as StrategyConfig['sizing']['mode'],
                      })
                    }
                  >
                    <option value="FIXED">Fixed stake</option>
                    <option value="BANKROLL_FRACTION">Bankroll fraction</option>
                    <option value="SIGNAL">Strategy recommendation</option>
                  </select>
                </label>
                <label className="field">
                  Fixed stake (BNB)
                  <input
                    type="number"
                    step="0.001"
                    value={cfg.sizing.fixedBnb}
                    onChange={(e) => upd('sizing', { ...cfg.sizing, fixedBnb: Number(e.target.value) })}
                  />
                </label>
                <label className="field">
                  Bankroll fraction (0–1)
                  <input
                    type="number"
                    step="0.001"
                    value={cfg.sizing.fraction}
                    onChange={(e) => upd('sizing', { ...cfg.sizing, fraction: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="stack" style={{ gap: 8 }}>
                <h3>Strategy limits</h3>
                <span className="muted small">
                  Optional. Can only tighten the global limits from the server environment.
                </span>
                {LIMITS.map(([k, label]) => (
                  <label key={k} className="field">
                    {label}
                    <input
                      type="number"
                      step="any"
                      value={cfg.limits[k] ?? ''}
                      placeholder="global"
                      onChange={(e) => {
                        const next = { ...cfg.limits };
                        if (e.target.value === '') delete next[k];
                        else next[k] = Number(e.target.value);
                        upd('limits', next);
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          </Card>
          <div className="row">
            <Seg
              value={mode}
              onChange={setMode}
              options={[
                { value: 'PAPER', label: 'Paper performance' },
                { value: 'LIVE', label: 'Live performance' },
              ]}
            />
          </div>
          {perf.data && (
            <>
              <SummaryTiles s={perf.data[mode].summary} />
              <PortfolioCharts report={perf.data[mode]} />
            </>
          )}
          <Card title="Recent decisions">
            <DecisionTable rows={data.recentDecisions.map((d) => ({ ...d, strategySlug: data.slug }))} />
          </Card>
        </div>
      )}
    </>
  );
}
