/**
 * Positive control for tools/gate-nul-audit.mjs.
 * Creates temporary files that reproduce the exact corruption pattern, confirms
 * the audit flags them, then removes them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const NUL = String.fromCharCode(0);
const root = process.cwd();

const cases = [
  {
    name: 'stripped-NUL shape (what actually bit me)',
    body: `const t = fs.readFileSync(p);\nif (t.includes('${NUL}')) continue;\n`,
    want: 'stripped-NUL shape',
  },
  {
    name: 'plain NUL byte, no logic inversion',
    body: `const data = "${NUL}";\n`,
    want: 'NUL byte present',
  },
];

for (const c of cases) {
  const p = path.join(root, `__nul_control_${c.want.replace(/\W+/g, '_')}.ts`);
  fs.writeFileSync(p, c.body, 'utf8');
  try {
    execSync('git add --intent-to-add -- ' + JSON.stringify(p), { stdio: 'ignore' });
    const out = execSync('node tools/gate-nul-audit.mjs', { encoding: 'utf8' });
    const detected = out.includes(path.basename(p));
    console.log(`${c.name}: detected=${detected} ${detected ? 'OK' : 'AUDIT IS BLIND'}`);
    if (!detected) process.exitCode = 2;
  } catch (err) {
    const out = (err.stdout ?? '') + (err.stderr ?? '');
    const detected = out.includes(path.basename(p));
    // Non-zero exit is expected here: the audit is *supposed* to fail.
    console.log(`${c.name}: detected=${detected} ${detected ? 'OK' : 'AUDIT IS BLIND'} (exit ${err.status})`);
    if (!detected) process.exitCode = 2;
  } finally {
    fs.rmSync(p, { force: true });
    try {
      execSync('git rm --cached --quiet -- ' + JSON.stringify(p), { stdio: 'ignore' });
    } catch {}
  }
}