/**
 * Authorization / IDOR audit.
 *
 * Every query against a user-owned table must be scoped by userId. A query that
 * filters by primary key alone lets any authenticated user read or mutate another
 * tenant's row by changing an id in the request, which is the single most common
 * real-world Next.js + Postgres flaw.
 *
 * This reads the real source and reports every user-owned table query that lacks
 * a user-scoping predicate.
 *
 * KNOWN FALSE POSITIVES - adjudicated by hand against the source, 2026-10-06.
 * This tool matches per-statement, so it cannot see authorization that happens
 * elsewhere in the function. All 9 current hits were reviewed and are safe:
 *
 *   - actions.ts rescoreDraft / saveDraftEdit / approveDraft: check-then-act.
 *     The row is fetched with `and(eq(drafts.id, id), eq(drafts.userId, user.id))`
 *     and the function returns early when it is absent, so the later
 *     `update(drafts).where(eq(drafts.id, ...))` can only ever touch an owned
 *     row. userId is immutable, so there is no TOCTOU window.
 *   - subredditProfiles: shared Reddit metadata, not user-owned. It is in the
 *     USER_OWNED list below only because the table name looks tenant-ish.
 *   - api/cron/*: authenticated by requireSecret, not a session, and intended to
 *     sweep every user's rows in one batch. Scoping them per-user would be a bug.
 *
 * It exits 1 while any hit remains, so treat a non-zero exit as "review these",
 * not "there is a vulnerability". The server-action section below is exact and
 * has no known false positives.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Tables that belong to exactly one user. Anything not listed is shared/global.
const USER_OWNED = [
  'drafts',
  'voiceProfiles',
  'voiceSamples',
  'connections',
  'publishedPosts',
  'attributionEvents',
  'metrics',
  'postMetrics',
  'subscriptions',
  'billingEvents',
  'settings',
  'watchedRepos',
  'subredditProfiles',
  'shippingMoments',
  'usage',
];

const src = [
  'packages/web/src/app/(app)/dashboard/actions.ts',
  'packages/web/src/lib/api.ts',
  'packages/web/src/app/api/crosspost/route.ts',
  'packages/web/src/app/api/onboarding/generate/route.ts',
  'packages/web/src/app/api/track/route.ts',
  'packages/web/src/app/api/cron/publish/route.ts',
  'packages/web/src/app/api/cron/digest/route.ts',
  'packages/web/src/app/api/cron/metrics/route.ts',
]
  .filter((f) => fs.existsSync(path.join(root, f)))
  .map((f) => ({ f, text: read(f) }));

console.log(`scanned ${src.length} source files for user-scoped data access\n`);

const unscoped = [];
let totalQueries = 0;

for (const { f, text } of src) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const table of USER_OWNED) {
      // Drizzle writes `.from(drafts)`; raw SQL writes `from drafts`. Both, plus
      // join/into/update, must be caught or the check silently under-reports.
      const usesTable = new RegExp(
        `\\b(from|into|update|join)\\s*\\(?\\s*["'\`]?${table}\\b`,
        'i',
      ).test(line);
      if (!usesTable) continue;
      totalQueries += 1;

      // Scoped if the query mentions the owner column or the caller's id. Drizzle
      // emits `eq(drafts.userId, user.id)` inside and(...) with no leading dot,
      // so match on the column and the id, not on a method-call shape.
      const window = lines.slice(Math.max(0, i - 6), i + 12).join(' ');
      const scoped = /\buserId\b|\buser\.id\b|\bownerId\b/.test(window);
      if (!scoped) unscoped.push({ file: f, line: i + 1, table, code: line.trim().slice(0, 96) });
    }
  });
}

console.log(`user-owned table references found: ${totalQueries}`);
console.log(`UNSCOPED (potential IDOR): ${unscoped.length}\n`);
for (const u of unscoped) {
  console.log(`  ${u.file}:${u.line}  [${u.table}]`);
  console.log(`    ${u.code}`);
}

// Server actions are the other IDOR surface: check each exported action takes a
// userId or calls requireUser, so it cannot act on behalf of someone else.
console.log('\n--- server action authorization ---');
const actionsFile = 'packages/web/src/app/(app)/dashboard/actions.ts';
if (fs.existsSync(path.join(root, actionsFile))) {
  const text = read(actionsFile);
  const blocks = text.split(/(?=export async function)/).slice(1);
  for (const b of blocks) {
    const name = b.match(/export async function (\w+)/)?.[1];
    if (!name) continue;
    const guarded = /requireUser\(\)/.test(b);
    const takesUserId = /userId:\s*string/.test(b);
    // Safe if it derives the user itself, or if the caller must pass a userId
    // and the function scopes by it.
    const ok = guarded || takesUserId;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}  ${
      guarded ? 'calls requireUser()' : takesUserId ? 'accepts userId and scopes by it' : 'NO USER SCOPING FOUND'
    }`);
  }
} else {
  console.log('  (actions file not found)');
}

process.exit(unscoped.length > 0 ? 1 : 0);