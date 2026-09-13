import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRow } from '../src/services/csvImport.js';
import { makeHarness, playRound } from './harness.js';

const V2_HEADER =
  'epoch,startTimestamp,lockTimestamp,closeTimestamp,lockPrice,closePrice,lockOracleId,closeOracleId,totalAmount,bullAmount,bearAmount,rewardBaseCalAmount,rewardAmount,oracleCalled,';
// Real rows from bsc-predict-updater data/v2/main/latest.csv.
const R408633 =
  '408633,1756587476,1756587776,1756588082,85933296956,85911406197,55340232221131082507,55340232221131082516,1547242055094045268,922406506093782956,624835549000262312,624835549000262312,1500824793441223910,True';
const R408634 =
  '408634,1756587782,1756588082,1756588389,85911406197,85990000000,55340232221131082516,55340232221131082525,1564958215521781753,912504246102161807,652453969419619946,912504246102161807,1518009469056128301,True';

describe('CSV parsing', () => {
  it('parses V2 rows exactly and derives outcomes', () => {
    const r = parseRow('PANCAKESWAP_V2', R408633.split(','));
    expect('ok' in r && r.ok.outcome).toBe('BEAR');
    expect('ok' in r && r.ok.record.rewardAmount).toBe(1500824793441223910n);
    const cancelled = parseRow('PANCAKESWAP_V2', R408634.replace(/True$/, 'False').split(','));
    expect('ok' in cancelled && cancelled.ok.status).toBe('CANCELLED');
  });

  it('parses V1 (block-based) and PRDT rows', () => {
    const v1 = parseRow(
      'PANCAKESWAP_V1',
      '1,6951937,6952037,6952137,54997895283,55301865660,0,0,0,0,0,True'.split(','),
    );
    expect('ok' in v1 && v1.ok.blocks).toEqual({ start: 6951937, lock: 6952037, close: 6952137 });
    expect('ok' in v1 && v1.ok.record.startTime).toBeNull();
    const prdt = parseRow(
      'PRDT',
      '28318,False,True,False,6770000000000000000,6722300000000000000,6722300000000000000,13491700000000000000,600000000000000,0,0,36711400000,36681600000,1646936274,1646936574,1646936874'.split(
        ',',
      ),
    );
    expect('ok' in prdt && prdt.ok.outcome).toBe('BEAR');
    expect(
      parseRow('PRDT', '2,False,False,False,0,0,0,0,0,0,0,0,0,1637871226,1637871526,1637871826'.split(',')),
    ).toEqual({ skip: 'incomplete' });
  });

  it('rejects malformed rows', () => {
    expect(parseRow('PANCAKESWAP_V2', R408633.split(',').concat(['x', 'y']))).toHaveProperty('error');
    expect(parseRow('PANCAKESWAP_V2', R408633.replace('85933296956', '8593x').split(','))).toHaveProperty(
      'error',
    );
    const badTotal = R408633.replace('1547242055094045268', '1547242055094045269');
    expect(parseRow('PANCAKESWAP_V2', badTotal.split(','))).toEqual({
      error: 'totalAmount != bullAmount + bearAmount',
    });
  });
});

describe('CSV import', () => {
  it('imports repeatably, collapses identical duplicates and excludes conflicting ones', async () => {
    const h = makeHarness();
    const conflicting = R408634.replace('85990000000', '85990000001');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-csv-')), 'rounds.csv');
    fs.writeFileSync(file, [V2_HEADER, R408633, R408633, R408634, conflicting, 'garbage,row', ''].join('\n'));

    const first = await h.app.csv.import({ format: 'PANCAKESWAP_V2', source: file });
    expect(first).toMatchObject({
      rowsRead: 5,
      inserted: 1,
      duplicatesIdentical: 1,
      duplicatesConflicting: 1,
      malformed: 1,
    });
    expect(first.conflictingEpochs).toEqual([408634]);
    const second = await h.app.csv.import({ format: 'PANCAKESWAP_V2', source: file });
    expect(second).toMatchObject({ inserted: 0, unchanged: 1 });
    const market = h.app.markets.tradable();
    expect(h.app.repos.rounds.stats(market.id)).toMatchObject({ total: 1, final: 1, bear: 1 });
    expect(h.app.repos.sync.imports()).toHaveLength(2);
    await h.app.close();
  });
});

describe('history sync (simulated chain)', () => {
  it('initial sync, idempotent re-sync, and incremental finalization', async () => {
    const h = makeHarness();
    for (const p of [600, 601, 602, 601, 600]) await playRound(h, p * 1e8, false);
    const market = h.app.markets.tradable();
    h.app.repos.db.exec('DELETE FROM rounds');

    const first = await h.app.history.syncAll();
    expect(first.inserted).toBe(h.chain.currentEpoch);
    const stats = h.app.repos.rounds.stats(market.id);
    expect(stats.total).toBe(h.chain.currentEpoch);
    expect(stats.final).toBe(h.chain.currentEpoch - 2); // open + live rounds are not final
    const again = await h.app.history.syncAll();
    expect(again.requested).toBe(2);
    expect(again.inserted).toBe(0);
    expect(h.app.repos.rounds.stats(market.id).total).toBe(h.chain.currentEpoch);

    h.chain.execute(599e8);
    const inc = await h.app.history.syncIncremental();
    expect(inc.finalized).toBe(1);
    expect(h.app.repos.rounds.stats(market.id).final).toBe(h.chain.currentEpoch - 2);
    await h.app.close();
  });

  it('marks a round cancelled only after close + buffer, from chain time', async () => {
    const h = makeHarness();
    await playRound(h, 600e8, false); // round 1 locked
    await playRound(h, 601e8, false); // round 1 ended, round 2 locked
    const live = h.chain.currentEpoch - 1;
    h.chain.advance(900); // operator stalls: round `live` cannot be ended any more
    await h.app.monitor.tick();
    const market = h.app.markets.tradable();
    const r = h.app.repos.rounds.get(market.id, live)!;
    expect(r.status).toBe('CANCELLED');
    expect(r.isFinal).toBe(true);
    expect(r.outcome).toBe('CANCELLED');
    await h.app.close();
  });

  it('reconciliation corrects CSV-imported data that disagrees with the chain', async () => {
    const h = makeHarness();
    for (const p of [600, 601, 602]) await playRound(h, p * 1e8, true);
    const market = h.app.markets.tradable();
    const epoch = 1;
    const chainRound = h.chain.round(epoch);
    h.app.repos.db.exec(`DELETE FROM rounds WHERE epoch = ${epoch}`);
    h.app.repos.rounds.upsert(market.id, {
      record: {
        ...chainRound,
        bullAmount: chainRound.bullAmount + 1n,
        totalAmount: chainRound.totalAmount + 1n,
      },
      status: 'ENDED',
      outcome: 'BULL',
      isFinal: true,
      source: 'CSV_IMPORT',
      treasuryFeeBps: 300,
    });
    const res = await h.app.history.reconcile();
    expect(res.sweep.corrected).toBe(1);
    const fixed = h.app.repos.rounds.get(market.id, epoch)!;
    expect(fixed.bullAmount).toBe(chainRound.bullAmount);
    expect(fixed.source).toBe('CHAIN');
    expect(h.app.repos.audit.list({ type: 'ROUND_CORRECTED' }, 10)).toHaveLength(1);
    await h.app.close();
  });

  it('flags the market as stale when RPC reads fail and recovers', async () => {
    const h = makeHarness();
    await h.app.monitor.tick();
    h.chain.snapshotFailures = 3;
    for (let i = 0; i < 3; i++) await h.app.monitor.tick();
    expect(h.app.monitor.state?.stale).toBe(true);
    expect(h.app.repos.audit.list({ type: 'RPC_UNAVAILABLE' }, 5)).toHaveLength(1);
    await h.app.monitor.tick();
    expect(h.app.monitor.state?.stale).toBe(false);
    expect(h.app.repos.audit.list({ type: 'RPC_RECOVERED' }, 5)).toHaveLength(1);
    await h.app.close();
  });
});
