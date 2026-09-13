import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EpochLink, ErrorBox, JsonView, PageHead, TxLink } from '../components/ui';
import { api, qs } from '../lib/api';
import { dateTimeMs } from '../lib/format';
import { useLive } from '../lib/live';
import type { AuditEvent } from '../types';

const SEVERITIES = ['', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

export function LogsPage() {
  const { subscribeAudit } = useLive();
  const [f, setF] = useState({ severity: '', type: '', component: '', epoch: '' });
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [more, setMore] = useState(true);

  const load = async (beforeId?: number) => {
    try {
      const page = await api<AuditEvent[]>(`/api/logs${qs({ ...f, beforeId, limit: 100 })}`);
      setRows((r) => (beforeId ? [...r, ...page] : page));
      setMore(page.length === 100);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.severity, f.type, f.component, f.epoch]);

  // Live-append matching events.
  useEffect(
    () =>
      subscribeAudit((e) => {
        if (f.severity && e.severity !== f.severity) return;
        if (f.type && e.type !== f.type) return;
        if (f.component && e.component !== f.component) return;
        if (f.epoch && String(e.epoch) !== f.epoch) return;
        setRows((r) => (r.some((x) => x.id === e.id) ? r : [e, ...r].slice(0, 1000)));
      }),
    [subscribeAudit, f],
  );

  return (
    <>
      <PageHead
        title="Audit log"
        desc="Append-only event trail (the database rejects updates and deletes). New events stream in live."
      />
      <div className="filters">
        <label className="field">
          Severity
          <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s || 'Any'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Event type
          <input
            value={f.type}
            onChange={(e) => setF({ ...f, type: e.target.value.toUpperCase() })}
            placeholder="e.g. BET_CONFIRMED"
          />
        </label>
        <label className="field">
          Component
          <input
            value={f.component}
            onChange={(e) => setF({ ...f, component: e.target.value })}
            placeholder="e.g. execution"
          />
        </label>
        <label className="field">
          Round
          <input
            value={f.epoch}
            onChange={(e) => setF({ ...f, epoch: e.target.value })}
            style={{ width: 100 }}
          />
        </label>
      </div>
      <ErrorBox error={error} />
      <Card>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Severity</th>
                <th>Type</th>
                <th>Component</th>
                <th>Round</th>
                <th>Trade</th>
                <th>Tx</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <tr
                    className={e.metadata ? 'clickable' : ''}
                    onClick={() => e.metadata && setOpen(open === e.id ? null : e.id)}
                  >
                    <td className="nowrap small">{dateTimeMs(e.ts)}</td>
                    <td className={`sev ${e.severity}`}>{e.severity}</td>
                    <td className="mono small">{e.type}</td>
                    <td className="small secondary">{e.component}</td>
                    <td onClick={(x) => x.stopPropagation()}>
                      {e.epoch !== null ? <EpochLink epoch={e.epoch} /> : ''}
                    </td>
                    <td onClick={(x) => x.stopPropagation()}>
                      {e.tradeId ? <Link to={`/trades/${e.tradeId}`}>#{e.tradeId}</Link> : ''}
                    </td>
                    <td onClick={(x) => x.stopPropagation()}>{e.txHash ? <TxLink hash={e.txHash} /> : ''}</td>
                    <td className="small">{e.message}</td>
                  </tr>
                  {open === e.id && (
                    <tr>
                      <td colSpan={8}>
                        <JsonView value={e.metadata} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {more && rows.length > 0 && (
          <div className="pager">
            <button className="small" onClick={() => void load(rows.at(-1)!.id)}>
              Load older
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
