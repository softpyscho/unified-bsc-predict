import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { ModeBadge, Status } from './components/ui';
import { api } from './lib/api';
import { countdown, usd } from './lib/format';
import { LiveProvider, useChainNow, useLive } from './lib/live';
import { BacktestPage, BacktestResultPage } from './pages/Backtest';
import { BotPage } from './pages/Bot';
import { DashboardPage } from './pages/Dashboard';
import { HistoryPage, RoundDetailPage } from './pages/History';
import { LivePage } from './pages/Live';
import { LogsPage } from './pages/Logs';
import { MarketsPage } from './pages/Markets';
import { PortfolioPage } from './pages/Portfolio';
import { SettingsPage } from './pages/Settings';
import { StrategiesPage, StrategyDetailPage } from './pages/Strategies';
import { TradeDetailPage, TradesPage } from './pages/Trades';
import { WalletPage } from './pages/Wallet';

const NAV: [string, string][] = [
  ['/', 'Dashboard'],
  ['/markets', 'Markets'],
  ['/live', 'Live Rounds'],
  ['/history', 'History'],
  ['/trades', 'Trades'],
  ['/portfolio', 'Portfolio'],
  ['/strategies', 'Strategies'],
  ['/backtest', 'Backtesting'],
  ['/bot', 'Bot'],
  ['/wallet', 'Wallet'],
  ['/settings', 'Settings'],
  ['/logs', 'Logs'],
];

export function App() {
  const [auth, setAuth] = useState<'unknown' | 'yes' | 'no'>('unknown');
  useEffect(() => {
    api('/api/auth/me')
      .then(() => setAuth('yes'))
      .catch(() => setAuth('no'));
    const onUnauthorized = () => setAuth('no');
    window.addEventListener('bsp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('bsp:unauthorized', onUnauthorized);
  }, []);
  if (auth === 'unknown') return <div className="content muted">Loading…</div>;
  if (auth === 'no') return <Login onDone={() => setAuth('yes')} />;
  return (
    <LiveProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/markets" element={<MarketsPage />} />
            <Route path="/live" element={<LivePage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/rounds/:epoch" element={<RoundDetailPage />} />
            <Route path="/trades" element={<TradesPage />} />
            <Route path="/trades/:id" element={<TradeDetailPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/strategies" element={<StrategiesPage />} />
            <Route path="/strategies/:id" element={<StrategyDetailPage />} />
            <Route path="/backtest" element={<BacktestPage />} />
            <Route path="/backtest/:id" element={<BacktestResultPage />} />
            <Route path="/bot" element={<BotPage />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="*" element={<div className="muted">Page not found.</div>} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </LiveProvider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/auth/login', { method: 'POST', body: { token } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16 }}>
      <form className="card" style={{ width: 'min(420px, 100%)' }} onSubmit={submit}>
        <h1 style={{ marginBottom: 6 }}>BSC Predict</h1>
        <p className="secondary" style={{ marginTop: 0 }}>
          Operator console. Enter the <code>ADMIN_API_TOKEN</code> from the server environment.
        </p>
        <label className="field">
          Admin token
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {error && (
          <div className="alert error" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        <button className="primary" style={{ marginTop: 12, width: '100%' }} disabled={!token}>
          Sign in
        </button>
      </form>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? 'system');
  const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const apply = () => {
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem('bsp-theme');
      else localStorage.setItem('bsp-theme', next);
    } catch {
      // ignore storage errors
    }
    setTheme(next);
  };
  return (
    <button className="small ghost" onClick={apply} title="Theme: system → light → dark">
      Theme: {theme}
    </button>
  );
}

function Topbar() {
  const { market, bot, connected } = useLive();
  const now = useChainNow();
  const next = market?.next;
  const toLock = next?.lockTime && now ? next.lockTime - now : null;
  return (
    <header className="topbar">
      <span className="row">
        <strong>BNB/USD</strong>
        <span className="num">{usd(market?.oracle?.price)}</span>
      </span>
      <span className="row secondary">
        Round #{market?.currentEpoch ?? '—'} locks in <strong className="num">{countdown(toLock)}</strong>
      </span>
      {market?.paused && <span className="badge live">CONTRACT PAUSED</span>}
      {market?.stale && <span className="badge live">MARKET DATA STALE</span>}
      <span className="spacer" />
      {bot && (
        <>
          <Status s={bot.status} />
          {bot.phase === 'RECOVERING' && <Status s="RECOVERING" />}
          {bot.paperTradingEnabled && <ModeBadge mode="PAPER" />}
          {bot.liveTradingEnabled && bot.liveArmed ? (
            <ModeBadge mode="LIVE" />
          ) : (
            <span className="badge">LIVE off</span>
          )}
        </>
      )}
      <span className="badge" title="Real-time stream">
        <span className="dot" style={{ background: connected ? 'var(--good)' : 'var(--critical)' }} />
        {connected ? 'stream' : 'offline'}
      </span>
      <ThemeToggle />
      <button
        className="small ghost"
        onClick={() => {
          void api('/api/auth/logout', { method: 'POST' }).finally(() => window.location.reload());
        }}
      >
        Sign out
      </button>
    </header>
  );
}

function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 11l4-4 3 3 5-6" stroke="var(--accent)" strokeWidth="2" fill="none" />
          </svg>
          <div>
            BSC Predict
            <small>prediction-market platform</small>
          </div>
        </div>
        <nav className="nav">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <Topbar />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
