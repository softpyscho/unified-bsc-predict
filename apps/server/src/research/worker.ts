/** Worker-thread entry: runs one research study off the main thread. */
import { parentPort } from 'node:worker_threads';
import { errorMessage } from '../util/json.js';
import type { StudyJob } from './runner.js';
import { runInline } from './runner.js';

const port = parentPort;
if (!port) throw new Error('research worker must run in a worker thread');
port.once('message', (job: StudyJob) => {
  try {
    port.postMessage({ result: runInline(job) });
  } catch (err) {
    port.postMessage({ error: errorMessage(err) });
  }
});
