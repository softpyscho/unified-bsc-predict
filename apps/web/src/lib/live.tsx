/**
 * Real-time layer: one EventSource per tab. Market and bot state are pushed by the server; other event types
 * bump per-type counters that pages use to refetch (debounced) — no polling of round state from the browser.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuditEvent, BotView, MarketState } from '../types';

type EventType = 'market' | 'bot' | 'trade' | 'decision' | 'audit' | 'backtest' | 'portfolio' | 'sync';

interface LiveValue {
  market: MarketState | null;
  marketReceivedAt: number;
  bot: BotView | null;
  connected: boolean;
  versions: Record<string, number>;
  backtest: Record<number, { status: string; progress?: number; error?: string }>;
  subscribeAudit: (fn: (e: AuditEvent) => void) => () => void;
}

const Ctx = createContext<LiveValue | null>(null);
const TYPES: EventType[] = ['market', 'bot', 'trade', 'decision', 'audit', 'backtest', 'portfolio', 'sync'];

export function LiveProvider({ children }: { children: ReactNode }) {
  const [market, setMarket] = useState<MarketState | null>(null);
  const [marketReceivedAt, setReceivedAt] = useState(0);
  const [bot, setBot] = useState<BotView | null>(null);
  const [connected, setConnected] = useState(false);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [backtest, setBacktest] = useState<LiveValue['backtest']>({});
  const auditSubs = useRef(new Set<(e: AuditEvent) => void>());
  const pending = useRef(new Set<string>());
  const flush = useRef<number | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    const bump = (type: string) => {
      pending.current.add(type);
      if (flush.current !== null) return;
      flush.current = window.setTimeout(() => {
        const types = [...pending.current];
        pending.current.clear();
        flush.current = null;
        setVersions((v) => {
          const next = { ...v };
          for (const t of types) next[t] = (next[t] ?? 0) + 1;
          return next;
        });
      }, 700);
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('hello', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { bot: BotView; market: MarketState | null };
      setBot(d.bot);
      if (d.market) {
        setMarket(d.market);
        setReceivedAt(Date.now());
      }
    });
    for (const type of TYPES) {
      es.addEventListener(type, (e) => {
        const data: unknown = JSON.parse((e as MessageEvent).data);
        if (type === 'market') {
          setMarket(data as MarketState);
          setReceivedAt(Date.now());
        } else if (type === 'bot') setBot(data as BotView);
        else if (type === 'audit') for (const fn of auditSubs.current) fn(data as AuditEvent);
        else if (type === 'backtest') {
          const b = data as { id: number; status: string; progress?: number; error?: string };
          setBacktest((prev) => ({ ...prev, [b.id]: b }));
        }
        if (type !== 'market') bump(type);
      });
    }
    return () => es.close();
  }, []);

  const subscribeAudit = useCallback((fn: (e: AuditEvent) => void) => {
    auditSubs.current.add(fn);
    return () => {
      auditSubs.current.delete(fn);
    };
  }, []);

  const value = useMemo(
    () => ({ market, marketReceivedAt, bot, connected, versions, backtest, subscribeAudit }),
    [market, marketReceivedAt, bot, connected, versions, backtest, subscribeAudit],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('LiveProvider missing');
  return v;
}

/** Chain time "now", extrapolated locally from the last market snapshot and re-rendered every second. */
export function useChainNow(): number | null {
  const { market, marketReceivedAt } = useLive();
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!market) return null;
  return market.chainTime + (Date.now() - marketReceivedAt) / 1000;
}

/** Sum of versions for the given event types — use as a dependency to refetch on server events. */
export function useVersion(types: string[]): number {
  const { versions } = useLive();
  return types.reduce((a, t) => a + (versions[t] ?? 0), 0);
}
