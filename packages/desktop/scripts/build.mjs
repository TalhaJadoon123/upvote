/**
 * Build script for the desktop app.
 *
 * Bundles the Electron main + preload with esbuild (following the workspace
 * TypeScript sources directly) and copies the renderer verbatim. The renderer is
 * plain HTML/CSS/JS on purpose: no bundler, no framework, no supply chain.
 *
 * Entry points are emitted to explicit paths because Electron resolves the
 * preload script relative to the bundled main file.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(root, '..');
const distDir = path.join(pkgRoot, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, 'renderer'), { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  // Electron is provided by the runtime, never bundled.
  external: ['electron'],
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: [path.join(pkgRoot, 'src/main/index.ts')],
  outfile: path.join(distDir, 'main.js'),
});

await build({
  ...shared,
  entryPoints: [path.join(pkgRoot, 'src/preload/index.ts')],
  outfile: path.join(distDir, 'preload.js'),
});

fs.cpSync(path.join(pkgRoot, 'src/renderer'), path.join(distDir, 'renderer'), { recursive: true });

console.log('desktop build complete ->', distDir);