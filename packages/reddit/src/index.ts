/**
 * @upvote/reddit — Reddit API client.
 *
 * Rule 1: every write goes out with the founder's own OAuth token.
 */
export * from './client.js';

/* ------------------------------------------------------------------ */
/* Flair helper                                                         */
/* ------------------------------------------------------------------ */

import type { RedditClient } from './client.js';

/**
 * Pick the best flair for a draft from a subreddit's template list.
 * Prefers an exact text match, then word overlap, then the first template
 * (a flair-less post is often filtered out, so posting something beats nothing).
 */
export function pickFlairId(
  flairs: ReadonlyArray<{ id: string; text: string }>,
  desired: string,
): string | undefined {
  if (flairs.length === 0) return undefined;
  if (!desired.trim()) return flairs[0]?.id;

  const lowerDesired = desired.toLowerCase();
  const exact = flairs.find((f) => f.text.toLowerCase() === lowerDesired);
  if (exact) return exact.id;

  const desiredWords = lowerDesired.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const scored = flairs
    .map((flair) => {
      const words = flair.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const hits = desiredWords.filter((w) => words.includes(w)).length;
      // Prefer "Discussion" / "Show" style flairs over "News" when unsure.
      const bonus = /discussion|show|tutorial|question|project/i.test(flair.text) ? 0.5 : 0;
      return { id: flair.id, score: hits + bonus };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.id ?? flairs[0]?.id;
}

/** Fetch flairs and resolve the id for a draft in one call. */
export async function resolveFlair(
  client: RedditClient,
  subreddit: string,
  desired: string,
): Promise<string | undefined> {
  const flairs = await client.getFlairs(subreddit);
  return pickFlairId(flairs, desired);
}