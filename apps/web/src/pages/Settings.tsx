import { useState } from 'react';
import { Card, ErrorBox, JsonView, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';

interface Settings {
  config: Record<string, unknown> & { risk: Record<string, unknown> };
  database: {
    sizeBytes: number | null;
    markets: {
      slug: string;
      total: number;
      final: number;
      minEpoch: number | null;
      maxEpoch: number | null;
    }[];
  };
  imports: {
    id: number;
    source: string;
    started_at: string;
    finished_at: string | null;
    rows_read: number;
    inserted: number;
    duplicates_identical: number;
    duplicates_conflicting: number;
    malformed: number;
    conflicts_with_db: number;
  }[];
  sync: {
    lastSyncedEpoch: number | null;
    lastSyncAt: string | null;
    lastReconcileAt: string | null;
    reconcileCursor: number | null;
  };
  plugins: { id: string; name: string; version: string }[];
}

const RISK_LABELS: Record<string, string> = {
  maxBetSize: 'Max bet size (BNB)',
  minBetSize: 'Min bet size (BNB)',
  escalationStakeThreshold: 'Escalation threshold (BNB)',
  escalationMinLossStreak: 'Consecutive losses to unlock escalation',
  maxBankrollFraction: 'Max bankroll fraction per trade',
  maxDailyLoss: 'Max daily loss (BNB)',
  maxConsecutiveLosses: 'Max consecutive losses',
  cooldownRounds: 'Cooldown after loss streak (rounds)',
  maxTotalExposure: 'Max total exposure (BNB)',
  minWalletBalance: 'Min wallet balance (BNB)',
  maxGasPriceGwei: 'Max gas price (gwei)',
  minSecondsBeforeLock: 'Latest submission (s before lock)',
};

export function SettingsPage() {
  const { data, error, reload } = useApi<Settings>('/api/settings', ['sync']);
  const action = useAction();
  const [out, setOut] = useState<unknown>(null);
  const run = (a: 'incremental' | 'reconcile') =>
    action.run(async () => {
      setOut(await api('/api/sync', { method: 'POST', body: { action: a } }));
      reload();
    });
  if (!data) return <ErrorBox error={error} />;
  const { risk, ...rest } = data.config;
  return (
    <>
      <PageHead
        title="Settings"
        desc="Runtime configuration comes from the server environment and is read-only here; global risk limits cannot be raised from the dashboard."
      />
      <ErrorBox error={error ?? action.error} />
      <div className="grid cols-2">
        <Card title="Global risk limits" sub="hard ceilings (environment)">
          <dl className="kv">
            {Object.entries(risk).map(([k, v]) => (
              <FragmentRow key={k} k={RISK_LABELS[k] ?? k} v={String(v)} />
            ))}
          </dl>
        </Card>
        <Card title="Runtime">
          <dl className="kv">
            {Object.entries(rest).map(([k, v]) => (
              <FragmentRow key={k} k={k} v={Array.isArray(v) ? v.join(', ') : String(v)} />
            ))}
          </dl>
        </Card>
        <Card
          title="Data synchronization"
          actions={
            <>
              <button disabled={action.pending} onClick={() => void run('incremental')}>
                Sync new rounds
              </button>
              <button disabled={action.pending} onClick={() => void run('reconcile')}>
                Reconcile
              </button>
            </>
          }
        >
          <dl className="kv">
            <FragmentRow k="Last synced epoch" v={String(data.sync.lastSyncedEpoch ?? '—')} />
            <FragmentRow k="Last sync" v={data.sync.lastSyncAt ?? '—'} />
            <FragmentRow k="Last reconciliation" v={data.sync.lastReconcileAt ?? '—'} />
            <FragmentRow k="Verification sweep cursor" v={String(data.sync.reconcileCursor ?? '—')} />
            <FragmentRow
              k="Database size"
              v={data.database.sizeBytes ? `${(data.database.sizeBytes / 1e6).toFixed(1)} MB` : '—'}
            />
          </dl>
          {action.pending && <div className="muted small">Running…</div>}
          {out !== null && <JsonView value={out} />}
        </Card>
        <Card title="Rounds by market">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th className="num">Rounds</th>
                <th className="num">Final</th>
                <th className="num">Epochs</th>
              </tr>
            </thead>
            <tbody>
              {data.database.markets.map((m) => (
                <tr key={m.slug}>
                  <td>{m.slug}</td>
                  <td className="num">{m.total.toLocaleString()}</td>
                  <td className="num">{m.final.toLocaleString()}</td>
                  <td className="num">
                    {m.minEpoch}–{m.maxEpoch}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 style={{ marginTop: 12 }}>Strategy plugins</h3>
          <div className="small secondary">
            {data.plugins.map((p) => `${p.name} v${p.version}`).join(' · ')}
          </div>
        </Card>
      </div>
      <Card title="Historical imports" sub="bsc-predict-updater CSV archives" className="">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Finished</th>
                <th>Source</th>
                <th className="num">Rows</th>
                <th className="num">Inserted</th>
                <th className="num">Identical dups</th>
                <th className="num">Conflicting dups</th>
                <th className="num">Malformed</th>
                <th className="num">Conflicts with DB</th>
              </tr>
            </thead>
            <tbody>
              {data.imports.map((i) => (
                <tr key={i.id}>
                  <td>#{i.id}</td>
                  <td className="small nowrap">
                    {i.finished_at ? dateTime(Date.parse(i.finished_at) / 1000) : 'running'}
                  </td>
                  <td
                    className="small mono"
                    style={{
                      maxWidth: 360,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={i.source}
                  >
                    {i.source.split(/[\\/]/).slice(-3).join('/')}
                  </td>
                  <td className="num">{i.rows_read.toLocaleString()}</td>
                  <td className="num">{i.inserted.toLocaleString()}</td>
                  <td className="num">{i.duplicates_identical.toLocaleString()}</td>
                  <td className="num">{i.duplicates_conflicting}</td>
                  <td className="num">{i.malformed}</td>
                  <td className="num">{i.conflicts_with_db}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className="mono small" style={{ overflowWrap: 'anywhere' }}>
        {v}
      </dd>
    </>
  );
}
