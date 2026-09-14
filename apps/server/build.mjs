// Bundles the server and CLI into dist/. Workspace packages (@bsc/core) are inlined; npm dependencies stay external.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@bsc/'));

await build({
  // The research worker runs studies on a worker thread; research/runner.ts loads it from next to main.js.
  entryPoints: { main: 'src/main.ts', cli: 'src/cli.ts', researchWorker: 'src/research/worker.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: [...deps, ...deps.map((d) => `${d}/*`)],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
