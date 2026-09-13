import { Link } from 'react-router-dom';
import { Addr, Card, ErrorBox, PageHead } from '../components/ui';
import { bnb, dateTime, pct } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { Market } from '../types';

export function MarketsPage() {
  const { data, error } = useApi<Market[]>('/api/markets', ['sync'], 60_000);
  return (
    <>
      <PageHead
        title="Markets"
        desc="One canonical round store for every prediction contract; only the V2 market is tradable."
      />
      <ErrorBox error={error} />
      <div className="grid cols-3">
        {data?.map((m) => {
          const decided = m.stats.bull + m.stats.bear;
          return (
            <Card
              key={m.id}
              title={m.name}
              actions={
                m.tradable ? (
                  <span className="badge live">TRADABLE</span>
                ) : (
                  <span className="badge">{m.active ? 'active' : 'historical'}</span>
                )
              }
            >
              <p className="secondary small" style={{ marginTop: 0 }}>
                {m.description}
              </p>
              <dl className="kv">
                <dt>Contract</dt>
                <dd>
                  <Addr a={m.contractAddress} chainId={m.chainId} />
                </dd>
                <dt>Protocol / timing</dt>
                <dd>
                  {m.protocol} · {m.timing.toLowerCase()}
                </dd>
                <dt>Rounds stored</dt>
                <dd>
                  <Link to={`/history?marketId=${m.id}`}>{m.stats.total.toLocaleString()}</Link> (
                  {m.stats.final.toLocaleString()} final)
                </dd>
                <dt>Epochs</dt>
                <dd>
                  {m.stats.minEpoch ?? '—'} – {m.stats.maxEpoch ?? '—'}
                </dd>
                <dt>Period</dt>
                <dd>
                  {m.timeRange.minStart
                    ? `${dateTime(m.timeRange.minStart).slice(0, 10)} → ${dateTime(m.timeRange.maxStart).slice(0, 10)}`
                    : 'block-based'}
                </dd>
                <dt>▲ UP / ▼ DOWN</dt>
                <dd>
                  {pct(decided ? m.stats.bull / decided : null)} /{' '}
                  {pct(decided ? m.stats.bear / decided : null)}
                </dd>
                <dt>Ties / cancelled</dt>
                <dd>
                  {m.stats.tie.toLocaleString()} / {m.stats.cancelled.toLocaleString()}
                </dd>
                <dt>Interval / buffer</dt>
                <dd>
                  {m.intervalSeconds ?? '—'}s / {m.bufferSeconds ?? '—'}s
                </dd>
                <dt>Treasury fee</dt>
                <dd>{(m.treasuryFeeBps / 100).toFixed(2)}%</dd>
                <dt>Min bet</dt>
                <dd>{m.minBetWei ? `${bnb(m.minBetWei)} BNB` : '—'}</dd>
              </dl>
            </Card>
          );
        })}
      </div>
    </>
  );
}
