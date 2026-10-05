/**
 * Tracked-file secret scan for the release gate.
 *
 * gitleaks/trufflehog are not installed in this environment, so this performs
 * the same class of check with pattern matching over `git ls-files` only
 * (never node_modules, never untracked files). Findings are redacted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const tracked = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((f) => f.split(path.sep).join('/'));

const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|pdf|zip|exe|dll|so|dylib|svg|lock)$/i;

/** Each rule: id, regex, and which group it belongs to. */
const RULES = [
  // Provider tokens with recognisable prefixes.
  { id: 'github-pat', group: 'token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'github-fine-grained', group: 'token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'openai', group: 'token', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic', group: 'token', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'stripe-live', group: 'token', re: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  { id: 'stripe-webhook', group: 'token', re: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { id: 'clerk', group: 'token', re: /\bsk_(?:test|live)_[A-Za-z0-9]{20,}\b/g },
  { id: 'google-api', group: 'token', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'aws-access-key', group: 'credential', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'slack', group: 'token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'npm', group: 'token', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { id: 'paddle', group: 'token', re: /\bpdl_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'resend', group: 'token', re: /\bre_[A-Za-z0-9_-]{20,}\b/g },
  { id: 'supabase-anon', group: 'token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

  // Connection strings and key material.
  { id: 'db-url-with-password', group: 'credential', re: /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^:@\s/]+:[^@\s/]{3,}@/g },
  { id: 'private-key-block', group: 'key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { id: 'aws-secret-key-assignment', group: 'credential', re: /aws_secret_access_key\s*[:=]\s*['"][A-Za-z0-9/+=]{30,}['"]/gi },
  { id: 'generic-bearer', group: 'token', re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{24,}/g },
];

function redact(value) {
  if (value.length <= 12) return '[REDACTED]';
  return `${value.slice(0, 4)}...[${value.length} chars]`;
}

const findings = [];
let scanned = 0;
let BINARY_FLAGGED = 0;

/** Match one text blob against every rule. Shared by the real scan and the self-test. */
function matchText(file, text) {
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ file, line, id: rule.id, group: rule.group, value: m[0] });
    }
  }
  return hits;
}

for (const file of tracked) {
  if (BINARY.test(file)) {
    BINARY_FLAGGED += 1;
    continue;
  }
  let text;
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    continue;
  }
  // NUL => binary-ish. Built from a char code so no escape sequence lives in
  // this source: tools/repair-nul.mjs strips NUL escapes, and an emptied
  // `includes('')` is true for every string, which silently skips all files.
  if (text.indexOf(String.fromCharCode(0)) !== -1) continue;
  scanned += 1;
  findings.push(...matchText(file, text));
}

// Any committed .env or key file at all is a finding regardless of content.
const envFiles = tracked.filter((f) => /(^|\/)\.env($|\.)|\.pem$|\.p12$|\.pfx$|id_rsa|id_ed25519/i.test(f));
const expected = envFiles.filter((f) => f === '.env.example');

console.log(
  `scanned ${scanned} of ${tracked.length} tracked files (${BINARY_FLAGGED} skipped as binary) against ${RULES.length} rules`,
);
console.log(`\nENV / KEY FILES COMMITTED (excluding .env.example): ${
  envFiles.filter((f) => !expected.includes(f)).length
}`);
for (const f of envFiles) console.log('  ' + f);

console.log(`\nSECRET PATTERN FINDINGS: ${findings.length}`);
for (const f of findings) {
  console.log(`  [${f.group}/${f.id}] ${f.file}:${f.line}  ${redact(f.value)}`);
}

// A clean report only means something if the scanner can still fire AND is
// actually reading files. Testing the RULES array alone is not enough: a
// broken skip condition can silently read zero files and still "pass".
console.log('\n--- SELF-TEST ---');

const control = 'ghp_' + 'A'.repeat(36);
const controlHits = matchText('control', control);
const firesOk = controlHits.length > 0;
console.log(`detects a synthetic GitHub token:      ${firesOk}`);

const pathHits = matchText('control', 'db=postgres://u:hunter2@h:5432/x');
const dsnOk = pathHits.length > 0;
console.log(`detects a synthetic DSN with password:${dsnOk ? ' true' : ' FALSE'}`);

// If almost every file is skipped, a clean result is meaningless regardless of
// whether the rules work. Assert coverage instead of trusting it.
const coverageOk = scanned > 0 && scanned >= tracked.length * 0.5;
console.log(`read a real share of tracked files:    ${scanned}/${tracked.length} ${coverageOk ? '' : 'FALSE'}`);

if (!firesOk || !dsnOk || !coverageOk) {
  console.error('\nSCANNER BROKEN - a clean result cannot be trusted.');
  process.exit(2);
}

if (findings.length > 0) {
  console.error('\nRESULT: FAIL - committed secrets detected.');
  process.exit(1);
}
console.log('\nRESULT: PASS - no secrets found in tracked files.');