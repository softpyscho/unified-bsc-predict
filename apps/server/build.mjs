// Bundles the server and CLI into dist/. Workspace packages (@bsc/core) are inlined; npm dependencies stay external.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@bsc/'));

await build({
  entryPoints: ['src/main.ts', 'src/cli.ts'],
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
