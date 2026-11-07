// Builds the Electron main process, preloads and CLI with esbuild, and the UI with Vite.
//   node scripts/build.mjs              everything
//   node scripts/build.mjs --only=node  main + preloads + CLI (fast)
//   node scripts/build.mjs --only=ui    the React UI
//   node scripts/build.mjs --watch      rebuild main/preload/CLI on change
import { build, context } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const watch = args.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  logLevel: 'warning',
  external: ['electron'],
  absWorkingDir: root,
  define: { 'process.env.CLICKLESS_BUILD': '"1"' },
};

const targets = [
  { ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' },
  // Preloads run sandboxed: a single file that only requires 'electron'.
  { ...common, entryPoints: ['src/preload/shell.ts'], outfile: 'dist/preload/shell.js', target: 'chrome140', sourcemap: 'inline' },
  { ...common, entryPoints: ['src/preload/content.ts'], outfile: 'dist/preload/content.js', target: 'chrome140', sourcemap: false },
  {
    ...common,
    entryPoints: ['src/cli/clickless.ts'],
    outfile: 'dist/cli/clickless.js',
    banner: { js: '#!/usr/bin/env node' },
    external: [],
  },
];

async function buildNode() {
  if (watch) {
    for (const t of targets) {
      const ctx = await context(t);
      await ctx.watch();
    }
    console.log('[build] watching main/preload/cli…');
    return;
  }
  await Promise.all(targets.map((t) => build(t)));
  chmodSync(path.join(root, 'dist/cli/clickless.js'), 0o755);
  console.log('[build] main, preloads, cli ✓');
}

function buildUI() {
  execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
  console.log('[build] ui ✓');
}

if (!only && !watch) rmSync(path.join(root, 'dist'), { recursive: true, force: true });
mkdirSync(path.join(root, 'dist'), { recursive: true });
if (!only || only === 'node') await buildNode();
if ((!only || only === 'ui') && !watch) buildUI();
