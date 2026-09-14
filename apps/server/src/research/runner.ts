/**
 * Runs a study on a worker thread when the bundled worker is available (the built server), so a multi-second
 * research run never stalls the trading loop; otherwise (tests, `tsx` development) it runs inline.
 */
import type { StudyOptions, StudyResult } from '@bsc/core';
import { runStudy } from '@bsc/core';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { EventColumns, RoundColumns } from './columns.js';
import { decodeEvents, decodeRounds, transferList } from './columns.js';

export interface StudyJob {
  rounds: RoundColumns;
  events: EventColumns | null;
  options: StudyOptions;
}

/** Emitted next to main.js / cli.js by build.mjs. */
const BUNDLED_WORKER = new URL('./researchWorker.js', import.meta.url);

export function runInline(job: StudyJob): StudyResult {
  return runStudy(decodeRounds(job.rounds), job.options, job.events ? decodeEvents(job.events) : undefined);
}

export function runStudyJob(
  job: StudyJob,
  opts: { worker?: URL | null; execArgv?: string[] } = {},
): Promise<StudyResult> {
  const worker =
    opts.worker !== undefined
      ? opts.worker
      : fs.existsSync(fileURLToPath(BUNDLED_WORKER))
        ? BUNDLED_WORKER
        : null;
  if (!worker) return Promise.resolve(runInline(job));
  return new Promise((resolve, reject) => {
    const w = new Worker(worker, { execArgv: opts.execArgv });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      void w.terminate();
    };
    w.once('message', (msg: { result?: StudyResult; error?: string }) =>
      finish(() => (msg.error !== undefined ? reject(new Error(msg.error)) : resolve(msg.result!))),
    );
    w.once('error', (err) => finish(() => reject(err)));
    w.once('exit', (code) => finish(() => reject(new Error(`research worker exited with code ${code}`))));
    w.postMessage(job, transferList(job.rounds, job.events));
  });
}
