/**
 * Repairs NUL bytes that a lossy text edit can introduce, and reports
 * surrounding context so the damage is visible rather than silent.
 */
import fs from 'node:fs';
import path from 'node:path';

const targets = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', '.turbo'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|mts|mjs|json|md|css)$/.test(entry.name)) targets.push(full);
  }
}
walk('.');

let repaired = 0;
for (const file of targets) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('\u0000')) continue;
  const before = text.length;
  // Collapse each run of NULs into nothing, then drop any dangling whitespace.
  const cleaned = text.replace(/\u0000+/g, '').replace(/[ \t]+\n/g, '\n');
  fs.writeFileSync(file, cleaned, 'utf8');
  repaired++;
  const lines = cleaned.split(/\r?\n/);
  const suspect = [];
  lines.forEach((line, i) => {
    if (line.trim().endsWith(',') && line.trim().length > 90) suspect.push([i + 1, line]);
  });
  console.log(`repaired ${file}: removed ${before - cleaned.length} NUL bytes`);
  for (const [lineNo, line] of suspect.slice(0, 6)) {
    console.log(`  check line ${lineNo}: ${line.slice(0, 110)}`);
  }
}
console.log(repaired === 0 ? 'no NUL bytes found' : `${repaired} file(s) repaired`);