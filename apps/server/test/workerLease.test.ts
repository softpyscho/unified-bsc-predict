import { describe, expect, it } from 'vitest';
import { Worker } from '../src/services/worker.js';
import { makeHarness } from './harness.js';

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('single active worker per database', () => {
  it('stands by while another worker holds the lease, takes over, and stops when the lease is lost', async () => {
    const h = await makeHarness();
    const db = h.app.repos.db;
    const grants = [false, false, true];
    let stillHeld = true;
    let released = 0;
    db.tryAcquireWorkerLease = async () => grants.shift() ?? true;
    db.checkWorkerLease = async () => stillHeld;
    db.releaseWorkerLease = async () => {
      released++;
    };
    const a = h.app;
    const worker = new Worker(
      a.ctx,
      {
        bot: a.bot,
        monitor: a.monitor,
        engine: a.engine,
        recovery: a.recovery,
        txReconciler: a.txReconciler,
        settlement: a.settlement,
        claims: a.claims,
        walletSync: a.walletSync,
        history: a.history,
        portfolio: a.portfolio,
        poolEvents: a.poolEvents,
      },
      { leaseCheckMs: 20 },
    );

    worker.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(worker.leaseHeld).toBe(false); // standby: nothing runs
    expect(worker.loopsRunning).toBe(false);
    expect(a.monitor.state).toBeNull();

    await waitFor(() => worker.leaseHeld, 'the lease');
    await waitFor(() => worker.loopsRunning, 'recovery and the trading loops');
    await waitFor(() => a.monitor.state !== null, 'a market snapshot');

    stillHeld = false; // e.g. the database connection dropped
    await waitFor(() => !worker.leaseHeld && !worker.loopsRunning, 'the loops to stop');

    stillHeld = true; // the lease is free again: take it back
    await waitFor(() => worker.leaseHeld && worker.loopsRunning, 'the takeover');

    await worker.stop();
    expect(worker.leaseHeld).toBe(false);
    expect(released).toBe(1);
    await h.app.close();
  });
});
