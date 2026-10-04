/**
 * Repairs NUL bytes that a lossy text edit can introduce, and reports
 * surrounding context so the damage is visible rather than silent.
 *
 * Run: node tools/repair-nul.mjs
 */
/* eslint-disable */
import fs from 'node:fs';
import path from 'node:path';

const NUL = String.fromCharCode(0);

const targets = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', '.turbo'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|mts|mjs|json|md|css|cjs)$/.test(entry.name)) targets.push(full);
  }
}
walk('.');

let repaired = 0;
for (const file of targets) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(NUL)) continue;
  const cleaned = text.split(NUL).join('').replace(/[ \t]+\n/g, '\n');
  fs.writeFileSync(file, cleaned, 'utf8');
  repaired += 1;
  console.log(`repaired ${file}`);
}
console.log(repaired === 0 ? 'no NUL bytes found' : `${repaired} file(s) repaired`);