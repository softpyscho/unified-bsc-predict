import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { bnb, explorer, short, signedBnb, tone } from '../lib/format';
import type { Direction, Mode, RiskCheck } from '../types';

export function Card({
  title,
  sub,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <h2>
            {title} {sub && <span className="sub">{sub}</span>}
          </h2>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tile({
  label,
  value,
  hint,
  cls,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  cls?: string;
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ''}`}>{value}</div>
      {hint !== undefined && <div className="hint">{hint}</div>}
    </div>
  );
}

export function PageHead({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function ModeBadge({ mode }: { mode: Mode }) {
  return <span className={`badge ${mode === 'LIVE' ? 'live' : 'paper'}`}>{mode}</span>;
}

export function Badge({ children, dot }: { children: ReactNode; dot?: string }) {
  return (
    <span className="badge">
      {dot && <span className="dot" style={{ background: dot }} />}
      {children}
    </span>
  );
}

/** Direction identity: colored swatch + arrow + text (never color alone). */
export function Dir({ d }: { d: Direction | null | undefined }) {
  if (!d) return <span className="muted">—</span>;
  return (
    <span className="dir">
      <span className="swatch" style={{ background: d === 'BULL' ? 'var(--bull)' : 'var(--bear)' }} />
      {d === 'BULL' ? '▲ UP' : '▼ DOWN'}
    </span>
  );
}

export function OutcomeTag({ o }: { o: string | null | undefined }) {
  if (!o) return <span className="muted">pending</span>;
  if (o === 'BULL' || o === 'BEAR') return <Dir d={o} />;
  return <span className="badge">{o}</span>;
}

const STATUS_DOT: Record<string, string> = {
  RUNNING: 'var(--good)',
  READY: 'var(--good)',
  CONFIRMED: 'var(--good)',
  SETTLED: 'var(--text-muted)',
  PAUSED: 'var(--warning)',
  RECOVERING: 'var(--warning)',
  SUBMITTING: 'var(--warning)',
  SUBMITTED: 'var(--warning)',
  PENDING: 'var(--warning)',
  STOPPED: 'var(--text-muted)',
  EMERGENCY_STOPPED: 'var(--critical)',
  FAILED: 'var(--critical)',
  OPEN: 'var(--good)',
  LIVE: 'var(--serious)',
  ENDED: 'var(--text-muted)',
  CANCELLED: 'var(--critical)',
};

export function Status({ s }: { s: string }) {
  return <Badge dot={STATUS_DOT[s] ?? 'var(--text-muted)'}>{s.replace('_', ' ')}</Badge>;
}

export function Money({
  wei,
  signed,
  dp = 4,
}: {
  wei: string | bigint | null | undefined;
  signed?: boolean;
  dp?: number;
}) {
  return (
    <span className={`num ${signed ? tone(wei) : ''}`}>{signed ? signedBnb(wei, dp) : bnb(wei, dp)}</span>
  );
}

export function TxLink({ hash, chainId }: { hash: string | null | undefined; chainId?: number }) {
  if (!hash) return <span className="muted">—</span>;
  return (
    <a className="mono" href={explorer('tx', hash, chainId)} target="_blank" rel="noreferrer noopener">
      {short(hash)}
    </a>
  );
}

export function Addr({ a, chainId }: { a: string | null | undefined; chainId?: number }) {
  if (!a) return <span className="muted">—</span>;
  return (
    <a className="mono" href={explorer('address', a, chainId)} target="_blank" rel="noreferrer noopener">
      {short(a)}
    </a>
  );
}

export function EpochLink({ epoch, marketId }: { epoch: number; marketId?: number }) {
  return <Link to={`/rounds/${epoch}${marketId ? `?marketId=${marketId}` : ''}`}>#{epoch}</Link>;
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="alert error">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="muted" style={{ padding: '14px 0' }}>
      {children}
    </div>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pager">
      <span>
        {total.toLocaleString()} rows · page {page.toLocaleString()} of {pages.toLocaleString()}
      </span>
      <button className="small" disabled={offset === 0} onClick={() => onChange(0)}>
        First
      </button>
      <button className="small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Prev
      </button>
      <button className="small" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next
      </button>
    </div>
  );
}

export function Checks({ checks }: { checks: RiskCheck[] }) {
  if (checks.length === 0)
    return <span className="muted small">no risk evaluation (strategy did not request a trade)</span>;
  return (
    <div className="checks">
      {checks.map((c) => (
        <div className="chk" key={c.rule}>
          <span className={c.passed ? 'ok' : 'no'} aria-label={c.passed ? 'passed' : 'failed'}>
            {c.passed ? '✓' : '✗'}
          </span>
          <span className="mono">{c.rule}</span>
          <span className="secondary">{c.detail}</span>
        </div>
      ))}
    </div>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
          role="tab"
          aria-selected={o.value === value}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Confirmation dialog; when `phrase` is set the user must type it exactly. */
export function Confirm({
  title,
  body,
  phrase,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  phrase?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (typed: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 style={{ marginBottom: 10 }}>{title}</h2>
        <div className="secondary" style={{ marginBottom: 12 }}>
          {body}
        </div>
        {phrase && (
          <label className="field" style={{ marginBottom: 12 }}>
            Type <code>{phrase}</code> to confirm
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={danger ? 'danger' : 'primary'}
            disabled={phrase !== undefined && typed !== phrase}
            onClick={() => onConfirm(typed)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
