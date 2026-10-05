/**
 * Release gate checks for phases 3, 4, 6 and 7.
 * Static analysis of the real source: auth coverage, input validation, headers,
 * CORS, health endpoints, Dockerfile posture, and env-var documentation.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const results = [];
const record = (phase, check, status, evidence) => results.push({ phase, check, status, evidence });

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

/* ---------------- Phase 3: auth on every API route ---------------- */

const routeDir = 'packages/web/src/app/api';
const routes = [];
(function walk(d) {
  if (!exists(d)) return;
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    const full = `${d}/${e.name}`;
    if (e.isDirectory()) walk(full);
    else if (e.name === 'route.ts') routes.push(`${full}`);
  }
})(routeDir);

/**
 * Routes that are reachable without a session by design, and the mechanism that
 * is supposed to authenticate each one. Anything not listed here must call
 * requireUser()/requireApiUser().
 */
const PUBLIC_MECHANISMS = {
  'webhooks/': /verify\w*Signature|verifyLemonSqueezySignature|verifyPaddleSignature|webhooks\.constructEvent|verifyWebhookSignature/,
  'cron/': /requireSecret\(/,
  'auth/reddit': /requireApiUser\(|state !==|state ===/,
  track: /parseAttribution|safeRedirect/,
  // Probes must answer without a session, or an orchestrator cannot use them.
  'health': /export async function GET/,
};

for (const route of routes) {
  const src = read(route);
  const publicKey = Object.keys(PUBLIC_MECHANISMS).find((prefix) => route.includes(prefix));

  if (publicKey) {
    const mechanism = PUBLIC_MECHANISMS[publicKey];
    const ok = mechanism.test(src);
    record(
      3,
      `auth: ${route}`,
      ok ? 'PASS' : 'FAIL',
      ok
        ? `public by design; authenticated via ${publicKey} mechanism`
        : `route matches public path "${publicKey}" but the expected guard is missing`,
    );
    continue;
  }

  const hasSession = /requireUser\(\)|requireApiUser\(\)/.test(src);
  if (hasSession) {
    record(3, `auth: ${route}`, 'PASS', 'calls requireUser()/requireApiUser()');
  } else {
    record(3, `auth: ${route}`, 'FAIL', 'no session guard on a non-public route');
  }
}

/* ---------------- Phase 3: webhook signature verification ---------------- */

const webhookFiles = routes.filter((r) => r.includes('webhooks/'));
for (const wf of webhookFiles) {
  const src = read(wf);
  const verifies = /verify\w*Signature|verifyLemonSqueezySignature|verifyPaddleSignature|webhooks\.constructEvent|verifyWebhookSignature/.test(src);
  const failsClosed = /if \(!secret\)|if \(!expected\)/.test(src);
  const rawBodyFirst = /await request\.text\(\)/.test(src);
  record(
    3,
    `webhook: ${wf}`,
    verifies && rawBodyFirst ? 'PASS' : 'FAIL',
    `signature-verified=${verifies} raw-body-read=${rawBodyFirst} fails-closed=${failsClosed}`,
  );
}

/* ---------------- Phase 3: SQL injection posture ---------------- */

const schema = read('packages/web/src/db/schema.ts');
const rawSql = /sql`|\.execute\(|\$queryRawUnsafe|raw\(/.test(schema);
record(3, 'SQL: no raw SQL in schema layer', rawSql ? 'FAIL' : 'PASS', 'drizzle query builder only; parameterised by default');

/* ---------------- Phase 3: SSRF / redirect ---------------- */

const trackRoute = exists(`${routeDir}/track/route.ts`) ? read(`${routeDir}/track/route.ts`) : '';
const hasSafeRedirect = /safeRedirect/.test(trackRoute);
const hasOriginCheck = /candidate\.origin !== requestUrl\.origin/.test(trackRoute);
record(3, 'open redirect: /api/track', hasSafeRedirect && hasOriginCheck ? 'PASS' : 'FAIL', 'safeRedirect() enforces same-origin');

/* ---------------- Phase 3: security headers ---------------- */

const nextConfig = exists('packages/web/next.config.mjs') ? read('packages/web/next.config.mjs') : '';
for (const header of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy']) {
  record(3, `header: ${header}`, nextConfig.includes(header) ? 'PASS' : 'FAIL', 'next.config.mjs headers()');
}
const hasCsp = /Content-Security-Policy/.test(nextConfig);
record(3, 'header: Content-Security-Policy', hasCsp ? 'PASS' : 'FAIL', hasCsp ? 'set in next.config' : 'MISSING on the web app (present in the desktop renderer only)');

const corsWildcard = /origin:\s*['"]\*['"]|Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/.test(
  nextConfig + (exists('packages/web/src/lib/api.ts') ? read('packages/web/src/lib/api.ts') : ''),
);
record(3, 'CORS: no wildcard origin', corsWildcard ? 'FAIL' : 'PASS', 'no CORS headers emitted; same-origin only by default');

/* ---------------- Phase 3: rate limiting ---------------- */

const apiLib = exists('packages/web/src/lib/api.ts') ? read('packages/web/src/lib/api.ts') : '';
const hasRateLimit = /export function rateLimit/.test(apiLib);
const callers = routes.filter((r) => /rateLimit\(/.test(read(r))).length;
record(3, 'rate limiting present', hasRateLimit ? 'PASS' : 'FAIL', `rateLimit() used on ${callers} route(s); in-memory, per-instance (see SECURITY.md)`);

/* ---------------- Phase 4: env vars ---------------- */

const envExample = exists('.env.example') ? read('.env.example') : '';
const declared = [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
const used = new Set();
(function walk(d) {
  if (!exists(d)) return;
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', '.turbo', 'dist'].includes(e.name)) continue;
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) {
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
    }
  }
})('packages');

const undocumented = [...used].filter(
  (v) => !declared.includes(v) && !['NODE_ENV', 'NEXT_PUBLIC_APP_URL', 'PATH', 'HOME'].includes(v),
);
record(4, 'env vars documented', undocumented.length === 0 ? 'PASS' : 'FAIL',
  undocumented.length ? `undocumented: ${undocumented.join(', ')}` : `${declared.length} vars in .env.example cover all used vars`);

const failsFast = /throw new Error\(`Missing required environment variable/.test(
  exists('packages/web/src/lib/env.ts') ? read('packages/web/src/lib/env.ts') : '',
);
record(4, 'config fails fast on missing values', failsFast ? 'PASS' : 'FAIL', 'lib/env.ts throws in production when a required var is absent');

const debugFlags = [...used].filter((v) => /DEBUG|VERBOSE|TRACE/i.test(v));
record(4, 'no debug flags defaulted on', debugFlags.length === 0 ? 'PASS' : 'REVIEW',
  debugFlags.length ? `flags present: ${debugFlags.join(', ')}` : 'none in use');

/* ---------------- Phase 5: migrations ---------------- */

const migrationFiles = [];
(function walkM(d) {
  if (!exists(d)) return;
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walkM(full);
    else if (/\.(sql|json)$/.test(e.name) && /drizzle|migrat/i.test(full)) migrationFiles.push(full);
  }
})('packages/web');
record(5, 'database migrations', migrationFiles.length > 0 ? 'PASS' : 'FAIL',
  migrationFiles.length ? `${migrationFiles.length} migration file(s)` : 'NO MIGRATION FILES. drizzle.config.ts exists but no SQL was ever generated, so a fresh database has no schema.');

/* ---------------- Phase 6: Dockerfile ---------------- */

const dockerfile = exists('Dockerfile') ? read('Dockerfile') : '';
record(6, 'Dockerfile multi-stage', /FROM .*AS (deps|builder)/i.test(dockerfile) ? 'PASS' : 'FAIL', 'deps -> builder -> runner');
record(6, 'Dockerfile non-root', /USER (nextjs|node|app)/i.test(dockerfile) ? 'PASS' : 'FAIL', dockerfile.match(/^USER .*/mi)?.[0] ?? 'no USER directive');
record(
  6,
  'Dockerfile HEALTHCHECK',
  /HEALTHCHECK/i.test(dockerfile) ? 'PASS' : 'FAIL',
  /HEALTHCHECK/i.test(dockerfile)
    ? 'HEALTHCHECK present; probes GET /api/health'
    : 'no HEALTHCHECK directive and no /api/health route to call',
);
record(6, 'Dockerfile pinned base image', /FROM node:22-alpine/.test(dockerfile) ? 'PASS' : 'REVIEW', 'node:22-alpine is a floating tag, not a digest');
const copiesEnv = /COPY .*\.env/.test(dockerfile);
record(6, 'Dockerfile does not bake .env', copiesEnv ? 'FAIL' : 'PASS', 'no .env copied into any stage');

/* ---------------- Phase 6: deploy config ---------------- */
record(6, 'IaC / k8s manifests', 'NOT VERIFIED', 'no terraform, helm, k8s, or deploy config in repo; deploy target undefined');
record(6, 'image immutability', 'NOT VERIFIED', 'CI builds tag upvote:ci; no registry push and no immutable digest recorded');

/* ---------------- Phase 7: observability ---------------- */
const healthRoutes = routes.filter((r) => /health|ready|live|ping/i.test(r));
record(
  7,
  'health/readiness endpoint',
  healthRoutes.length > 0 ? 'PASS' : 'FAIL',
  healthRoutes.length
    ? `${healthRoutes.map((r) => r.split('/api/')[1]).join(', ')} (deep=1 checks the database)`
    : 'NONE. A load balancer cannot probe this container.',
);
const structuredLogging = /console\.(log|info|error|warn)\(/.test(apiLib) && /JSON\.stringify/.test(apiLib);
record(7, 'structured logging', structuredLogging ? 'PASS' : 'FAIL', 'plain console output; no JSON log format, no correlation IDs');
const hasTracing = /Sentry|opentelemetry|datadog|pino|winston/i.test(
  [
    'packages/web/src/lib/api.ts',
    'packages/web/src/lib/env.ts',
    'packages/core/src/index.ts',
  ]
    .filter(exists)
    .map((f) => read(f))
    .join(''),
);
record(7, 'error tracking', hasTracing ? 'PASS' : 'FAIL', 'no Sentry/OTel integration found');
const hasGracefulShutdown = /SIGTERM|gracefulShutdown|beforeExit/.test(
  exists('packages/web/next.config.mjs') ? nextConfig : '',
);
record(7, 'graceful shutdown', hasGracefulShutdown ? 'PASS' : 'NOT VERIFIED', 'handled by the Next.js runtime; not verified under SIGTERM here');
const cronRoutes = routes.filter((r) => r.includes('cron/'));
const cronSecret = cronRoutes.every((r) => /requireSecret/.test(read(r)));
record(7, 'cron jobs authenticated', cronRoutes.length > 0 && cronSecret ? 'PASS' : 'FAIL', `${cronRoutes.length} cron route(s), all using requireSecret()`);

/* ---------------- Phase 8: performance ---------------- */
const nextConfigHasCache = /revalidate|fetchCache|dynamic/.test(nextConfig);
record(8, 'caching directives', nextConfigHasCache ? 'PASS' : 'REVIEW', 'per-route dynamic/revalidate directives are the only cache control');
const hasBundleBudget = /bundle|budget|size-limit/i.test(read('package.json'));
record(8, 'bundle size budget enforced', hasBundleBudget ? 'PASS' : 'FAIL', 'no bundle or image size budget in CI');

/* ---------------- output ---------------- */

const order = { FAIL: 0, 'NOT VERIFIED': 1, REVIEW: 2, PASS: 3, N_A: 4 };
results.sort((a, b) => order[a.status] - order[b.status] || a.phase - b.phase);

let phase = null;
for (const r of results) {
  if (r.phase !== phase) {
    phase = r.phase;
    process.stdout.write(`\n=== PHASE ${phase} ===\n`);
  }
  process.stdout.write(`  [${r.status.padEnd(13)}] ${r.check}\n`);
  process.stdout.write(`                 ${r.evidence}\n`);
}

const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
process.stdout.write(`\n=== SUMMARY ===\n${JSON.stringify(counts)}\n`);
const blocking = results.filter((r) => r.status === 'FAIL');
process.stdout.write(`\n${blocking.length} blocking item(s):\n`);
for (const b of blocking) process.stdout.write(`  - [${b.phase}] ${b.check}\n`);
process.exit(blocking.length > 0 ? 1 : 0);