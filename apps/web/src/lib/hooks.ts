import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useVersion } from './live';

/**
 * Fetches `path`, refetching when any of `refreshOn` server events arrive (and optionally on an interval).
 * The previous data is kept while reloading — no skeleton flash, no layout jump.
 */
export function useApi<T>(path: string | null, refreshOn: string[] = [], intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const version = useVersion(refreshOn);
  const current = useRef(0);

  useEffect(() => {
    if (!path) return;
    const id = ++current.current;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (id === current.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (id === current.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (id === current.current) setLoading(false);
      });
  }, [path, version, nonce]);

  useEffect(() => {
    if (!intervalMs) return;
    const t = window.setInterval(() => setNonce((n) => n + 1), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Runs an async action with pending state and an error message. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, run, setError };
}
