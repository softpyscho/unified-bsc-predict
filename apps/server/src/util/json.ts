/** JSON helpers: bigint is serialized as a decimal string (wei), never as a lossy number. */

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Deep-converts bigints to strings so a value can be sent over HTTP/SSE. */
export function toWire<T>(value: T): unknown {
  return JSON.parse(stringify(value)) as unknown;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
