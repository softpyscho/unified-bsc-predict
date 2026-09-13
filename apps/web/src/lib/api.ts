export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** Same-origin JSON API client. The session is an HttpOnly cookie, so no token is held in JS. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const body = method === 'GET' ? undefined : JSON.stringify(init.body ?? {});
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body,
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login'))
    window.dispatchEvent(new Event('bsp:unauthorized'));
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const d = data as { error?: string; issues?: { path: string; message: string }[] } | null;
    const detail = d?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new ApiError(res.status, detail ? `${d?.error}: ${detail}` : (d?.error ?? res.statusText), data);
  }
  return data as T;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length === 0
    ? ''
    : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}
