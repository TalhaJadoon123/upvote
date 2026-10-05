/**
 * Phase 0-1 discovery helper for the release gate.
 * Prints the inventory the gate needs, without mutating anything.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', '.turbo', 'dist', '.source'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, depth + 1);
    else out.push(path.relative(root, full));
  }
  return out;
}

const files = walk(root).map((f) => f.split(path.sep).join('/'));

const groups = {
  'IaC / k8s / terraform': files.filter((f) => /\.(tf|tfvars|hcl)$/.test(f) || /k8s|kubernetes|helm|charts?\//i.test(f)),
  migrations: files.filter((f) => /migrat/i.test(f)),
  'CI/CD workflows': files.filter((f) => /\.github\/workflows\//.test(f)),
  Docker: files.filter((f) => /Dockerfile|docker-compose|\.dockerignore/i.test(f)),
  'env examples': files.filter((f) => /\.env/i.test(f)),
  tests: files.filter((f) => /tests?\//.test(f) && /\.tsx?$/.test(f)),
  docs: files.filter((f) => /\.mdx?$/.test(f)),
  'API routes': files.filter((f) => /app\/api\/.*route\.ts$/.test(f)),
  'server actions': files.filter((f) => /actions\.ts$/.test(f)),
  tools: files.filter((f) => f.startsWith('tools')),
};

for (const [label, list] of Object.entries(groups)) {
  console.log(`\n--- ${label} (${list.length}) ---`);
  for (const f of list.slice(0, 25)) console.log('  ' + f);
  if (list.length > 25) console.log(`  ... +${list.length - 25} more`);
}

// Health / readiness endpoints: a hard requirement for any containerised deploy.
console.log('\n--- health/readiness endpoints ---');
const routes = files.filter((f) => /app\/api\/.*route\.ts$/.test(f));
const health = routes.filter((f) => /health|ready|live|ping|status/i.test(f));
console.log(health.length ? health.join('\n') : 'NONE FOUND');

// Largest tracked files, to catch accidental large binaries.
console.log('\n--- largest tracked files ---');
const { execSync } = await import('node:child_process');
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const sized = tracked
  .map((f) => {
    try {
      return { f, size: fs.statSync(path.join(root, f)).size };
    } catch {
      return { f, size: 0 };
    }
  })
  .sort((a, b) => b.size - a.size)
  .slice(0, 12);
for (const s of sized) console.log(`  ${(s.size / 1024).toFixed(1)} KB  ${s.f}`);

// Any tracked file over 1 MB is a packaging concern for the image.
const big = tracked.filter((f) => {
  try {
    return fs.statSync(path.join(root, f)).size > 1024 * 1024;
  } catch {
    return false;
  }
});
console.log('\ntracked files > 1MB:', big.length ? big.join(', ') : 'none');

// CHANGELOG / release notes presence.
const changelog = tracked.filter((f) => /CHANGELOG|RELEASE_NOTES|changes\//i.test(f));
console.log('changelog/release notes:', changelog.length ? changelog.join(', ') : 'ABSENT');