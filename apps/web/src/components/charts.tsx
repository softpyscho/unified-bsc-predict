/**
 * Chart components following the data-viz spec: one y-axis, 2px lines, hairline solid grid, bars <= 24px with
 * rounded data ends, crosshair tooltips (value first), a legend for >= 2 series, and a table-view twin.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
];

export interface TableData {
  columns: string[];
  rows: (string | number)[][];
}

export function ChartCard({
  title,
  sub,
  table,
  children,
  legend,
}: {
  title: string;
  sub?: string;
  table: TableData;
  children: ReactNode;
  legend?: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {title} {sub && <span className="sub">{sub}</span>}
        </h2>
        <div className="seg">
          <button className={view === 'chart' ? 'on' : ''} onClick={() => setView('chart')}>
            Chart
          </button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>
            Table
          </button>
        </div>
      </div>
      {view === 'chart' ? (
        <>
          {legend}
          {children}
        </>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                {table.columns.map((c, i) => (
                  <th key={c} className={i > 0 ? 'num' : ''}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={j > 0 ? 'num' : ''}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Legend({ items, rect }: { items: { label: string; color: string }[]; rect?: boolean }) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <span className={`key ${rect ? 'rect' : ''}`} style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

interface TipProps {
  active?: boolean;
  payload?: {
    name?: string;
    value?: number;
    color?: string;
    stroke?: string;
    fill?: string;
    payload?: Record<string, unknown>;
  }[];
  label?: string | number;
}

function makeTip(xFormat: (x: string | number) => string, yFormat: (y: number) => string) {
  return function Tip({ active, payload, label }: TipProps) {
    if (!active || !payload || payload.length === 0) return null;
    return (
      <div className="tip">
        <div className="x">{label !== undefined ? xFormat(label) : ''}</div>
        {payload.map((p, i) => (
          <div className="r" key={i}>
            <span className="k" style={{ background: p.stroke ?? p.color ?? p.fill }} />
            <strong>{p.value === undefined ? '—' : yFormat(p.value)}</strong>
            {payload.length > 1 && <span className="muted">{p.name}</span>}
          </div>
        ))}
      </div>
    );
  };
}

const axisProps = { stroke: 'var(--axis)', tickLine: false, axisLine: { stroke: 'var(--axis)' } } as const;
const fmtBnb = (v: number) =>
  `${v >= 0 ? '' : '−'}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 4 })} BNB`;
const fmtTick = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${+v.toFixed(4)}`);

export interface Series {
  key: string;
  label: string;
  points: { x: number; y: number }[];
}

/** Merges step series (e.g. cumulative P&L) on a shared x grid with carry-forward, capped to `max` rows. */
function mergeStep(series: Series[], max = 1500): Record<string, number>[] {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const stride = Math.max(1, Math.ceil(xs.length / max));
  const idx = series.map(() => 0);
  const last: (number | undefined)[] = series.map(() => undefined);
  const rows: Record<string, number>[] = [];
  xs.forEach((x, n) => {
    series.forEach((s, si) => {
      while (idx[si]! < s.points.length && s.points[idx[si]!]!.x <= x) last[si] = s.points[idx[si]!++]!.y;
    });
    if (n % stride === 0 || n === xs.length - 1) {
      const row: Record<string, number> = { x };
      series.forEach((s, si) => {
        if (last[si] !== undefined) row[s.key] = last[si]!;
      });
      rows.push(row);
    }
  });
  return rows;
}

export function StepLines({
  series,
  height = 260,
  xFormat,
  yFormat = fmtBnb,
  zeroLine = true,
}: {
  series: Series[];
  height?: number;
  xFormat: (x: number) => string;
  yFormat?: (y: number) => string;
  zeroLine?: boolean;
}) {
  const data = useMemo(() => mergeStep(series), [series]);
  const Tip = useMemo(() => makeTip((x) => xFormat(Number(x)), yFormat), [xFormat, yFormat]);
  if (data.length === 0)
    return (
      <div className="muted" style={{ height, display: 'grid', placeItems: 'center' }}>
        No data yet
      </div>
    );
  return (
    <div className="chart-box" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="x"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={xFormat}
            {...axisProps}
            minTickGap={40}
          />
          <YAxis tickFormatter={fmtTick} {...axisProps} width={56} />
          {zeroLine && <ReferenceLine y={0} stroke="var(--axis)" />}
          <Tooltip
            content={<Tip />}
            cursor={{ stroke: 'var(--text-muted)', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          {series.map((s, i) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              type="stepAfter"
              stroke={SERIES[i % SERIES.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--surface-1)', strokeWidth: 2 }}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DrawdownArea({
  points,
  height = 180,
  xFormat,
}: {
  points: { x: number; y: number }[];
  height?: number;
  xFormat: (x: number) => string;
}) {
  const Tip = useMemo(() => makeTip((x) => xFormat(Number(x)), fmtBnb), [xFormat]);
  const data = useMemo(() => points.map((p) => ({ x: p.x, dd: -p.y })), [points]);
  if (data.length === 0)
    return (
      <div className="muted" style={{ height, display: 'grid', placeItems: 'center' }}>
        No data yet
      </div>
    );
  return (
    <div className="chart-box" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="x"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={xFormat}
            {...axisProps}
            minTickGap={40}
          />
          <YAxis tickFormatter={fmtTick} {...axisProps} width={56} />
          <Tooltip
            content={<Tip />}
            cursor={{ stroke: 'var(--text-muted)', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <Area
            dataKey="dd"
            name="Drawdown"
            type="stepAfter"
            stroke="var(--div-neg)"
            strokeWidth={2}
            fill="var(--div-neg)"
            fillOpacity={0.1}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Bars colored by sign using the diverging pair (blue = gain, red = loss); the sign is also in the value text. */
export function SignedBars({
  data,
  height = 220,
  yFormat = fmtBnb,
}: {
  data: { label: string; value: number }[];
  height?: number;
  yFormat?: (v: number) => string;
}) {
  const Tip = useMemo(() => makeTip((x) => String(x), yFormat), [yFormat]);
  if (data.length === 0)
    return (
      <div className="muted" style={{ height, display: 'grid', placeItems: 'center' }}>
        No data yet
      </div>
    );
  return (
    <div className="chart-box" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" {...axisProps} minTickGap={24} />
          <YAxis tickFormatter={fmtTick} {...axisProps} width={56} />
          <ReferenceLine y={0} stroke="var(--axis)" />
          <Tooltip content={<Tip />} cursor={{ fill: 'var(--surface-2)' }} isAnimationActive={false} />
          <Bar dataKey="value" name="Net P&L" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.value >= 0 ? 'var(--div-pos)' : 'var(--div-neg)'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Single-series distribution bars (slot 1). */
export function Histogram({
  data,
  height = 200,
  unit = 'trades',
}: {
  data: { label: string; count: number }[];
  height?: number;
  unit?: string;
}) {
  const Tip = useMemo(
    () =>
      makeTip(
        (x) => String(x),
        (v) => `${v.toLocaleString()} ${unit}`,
      ),
    [unit],
  );
  return (
    <div className="chart-box" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" {...axisProps} interval={0} tick={{ fontSize: 10 }} />
          <YAxis allowDecimals={false} {...axisProps} width={44} />
          <Tooltip content={<Tip />} cursor={{ fill: 'var(--surface-2)' }} isAnimationActive={false} />
          <Bar
            dataKey="count"
            name="Count"
            fill="var(--series-1)"
            maxBarSize={24}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
