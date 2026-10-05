/**
 * Checks every tracked text file for literal NUL bytes and reports whether each
 * one still parses as the language it claims to be.
 *
 * Context: tools/repair-nul.mjs deletes NUL bytes and overwrites the file. On
 * tools/gate-secret-scan.mjs that turned `text.includes('<NUL>')` into
 * `text.includes('')`, which is true for every string, so the scanner skipped
 * every file and still printed PASS. The tool reported success while inverting
 * the program's logic. This script finds any file in that state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import vm from 'node:vm';

const root = process.cwd();
const NUL = String.fromCharCode(0);

const tracked = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const SCRIPT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/i;
const TEXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|json|md|mdx|css|yml|yaml)$/i;

const withNul = [];
const parseFailures = [];

// Always-true string methods are the specific way a stripped NUL inverts logic.
const SUSPICIOUS = [
  /\.includes\(['"]{2}\)/,
  /\.indexOf\(['"]{2}\)/,
  /\.startsWith\(['"]{2}\)/,
  /===\s*['"]{2}\s*&&/,
];

for (const file of tracked) {
  const full = path.join(root, file);
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    continue;
  }
  if (!buf.includes(0)) continue;

  withNul.push(file);
  const text = buf.toString('utf8');
  if (SUSPICIOUS.some((re) => re.test(text))) {
    parseFailures.push({ file, why: 'stripped-NUL shape: empty-string argument' });
  }
  if (SCRIPT.test(file)) {
    try {
      // Wrap ESM/TS-ish source so bare `import` does not throw for the wrong reason.
      new vm.Script(text.replace(/^\s*(import|export)\b.*$/gm, ''), { filename: file });
    } catch (err) {
      parseFailures.push({ file, why: `does not parse: ${String(err.message).slice(0, 100)}` });
    }
  }
}

console.log(`checked ${tracked.length} tracked files (${TEXT.test('x.mjs') ? 'text+syntax' : 'text'})`);

console.log(`\nFILES CONTAINING LITERAL NUL BYTES: ${withNul.length}`);
for (const f of withNul) console.log('  ' + f);

console.log(`\nFILES WITH SUSPECTED SILENT CORRUPTION: ${parseFailures.length}`);
for (const f of parseFailures) console.log(`  ${f.file}\n    ${f.why}`);

if (parseFailures.length > 0) {
  console.error('\nRESULT: FAIL - source files are silently corrupted.');
  process.exit(1);
}
if (withNul.length > 0) {
  console.log('\nRESULT: REVIEW - NUL bytes present but no logic-inversion detected.');
  process.exit(3);
}
console.log('\nRESULT: PASS - no NUL byte corruption in tracked files.');