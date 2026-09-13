export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries transient failures with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        opts.onRetry?.(err, i + 1);
        await sleep(base * 2 ** i);
      }
    }
  }
  throw lastErr;
}

/** Runs `fn` over items with bounded concurrency, preserving result order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}
