import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time secret comparison.
 *
 * A plain `!==` leaks the length and the first differing byte through timing,
 * which is enough to recover a shared secret one request at a time. The cron
 * endpoints authenticate with a secret, so they get a real comparison.
 *
 * Returns false when either side is missing or the lengths differ; the length
 * check is unavoidable because `timingSafeEqual` throws on mismatched buffers,
 * and the length of a high-entropy secret is not itself sensitive.
 */
export function secretMatches(provided: string | null | undefined, expected: string | undefined | null): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Guard for endpoints that must never run unconfigured. */
export function requireSecret(
  provided: string | null | undefined,
  expected: string | undefined | null,
  label: string,
): { ok: true } | { ok: false; error: string } {
  if (!expected) return { ok: false, error: `${label} is not configured on the server.` };
  if (!secretMatches(provided, expected)) return { ok: false, error: 'Unauthorized.' };
  return { ok: true };
}