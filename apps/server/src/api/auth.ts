/**
 * Operator authentication: a single admin token (ADMIN_API_TOKEN). The dashboard exchanges it for an
 * HttpOnly, SameSite=Strict session cookie; scripts may send it as a Bearer token. Comparisons are
 * constant-time and login attempts are rate limited per client address.
 */
import crypto from 'node:crypto';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest();

export const SESSION_COOKIE = 'bsp_session';

export class Sessions {
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly token: string,
    private readonly ttlMs = 12 * 60 * 60 * 1000,
    private readonly maxAttempts = 10,
    private readonly windowMs = 5 * 60 * 1000,
  ) {}

  verifyToken(candidate: string | undefined): boolean {
    if (!candidate) return false;
    return crypto.timingSafeEqual(sha256(candidate), sha256(this.token));
  }

  create(): string {
    const id = crypto.randomBytes(32).toString('hex');
    this.sessions.set(id, Date.now() + this.ttlMs);
    return id;
  }

  valid(id: string | undefined): boolean {
    if (!id) return false;
    const expires = this.sessions.get(id);
    if (expires === undefined) return false;
    if (expires < Date.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  revoke(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  isRateLimited(ip: string): boolean {
    const a = this.attempts.get(ip);
    if (!a || a.resetAt < Date.now()) return false;
    return a.count >= this.maxAttempts;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const a = this.attempts.get(ip);
    if (!a || a.resetAt < now) this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs });
    else a.count++;
  }

  clearFailures(ip: string): void {
    this.attempts.delete(ip);
  }
}
