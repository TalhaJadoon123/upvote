/**
 * Anti-spam guardrails.
 *
 * Being removed from a subreddit is expensive and slow to recover from, so the
 * scheduler enforces these before every post — even when the user has enabled
 * full auto-posting. Every check returns a reason string so the UI can explain
 * the hold.
 */
import { GuardrailConfigSchema } from './types.js';
import type { GuardrailConfig, PostingHistoryEntry } from './types.js';
import { differenceInCalendarDays, differenceInHours } from './dates.js';

export const DEFAULT_GUARDRAILS: GuardrailConfig = GuardrailConfigSchema.parse({});

export interface GuardrailDecision {
  allowed: boolean;
  /** Machine codes: daily_cap, weekly_cap, blocklist, cooldown, account_age, prior_engagement, approval. */
  codes: string[];
  messages: string[];
  /** Earliest time a blocked post becomes permissible, if we can compute one. */
  retryAfter?: string;
}

export interface GuardrailInput {
  userId: string;
  subreddit: string;
  /** Posts already queued (approved or scheduled) — not yet published. */
  pending?: Array<{ subreddit: string; scheduledFor: string }>;
  /** Everything actually published. */
  history: readonly PostingHistoryEntry[];
  config?: Partial<GuardrailConfig>;
  accountAgeDays?: number;
  /** Subreddits the user has ever commented in. */
  engagedSubreddits?: readonly string[];
  approved: boolean;
  /** Authenticity score of the draft. */
  authenticityScore?: number;
  now?: Date;
}

/**
 * Decide whether a draft may be posted right now (or scheduled for a time).
 * Returns `allowed: false` with every reason, not just the first — the founder
 * needs to see the whole picture to fix their cadence settings.
 */
export function evaluateGuardrails(input: GuardrailInput): GuardrailDecision {
  const config = GuardrailConfigSchema.parse(input.config ?? {});
  const now = input.now ?? new Date();
  const codes: string[] = [];
  const messages: string[] = [];
  let retryAfter: string | undefined;

  const isApproved = input.approved;
  const queue = [
    ...input.history.filter((h) => !h.removed).map((h) => ({ subreddit: h.subreddit, at: h.postedAt })),
    ...(input.pending ?? []).map((p) => ({ subreddit: p.subreddit, at: p.scheduledFor })),
  ];

  /* --- daily cap --- */
  const today = now.toISOString().slice(0, 10);
  const postsToday = queue.filter((q) => new Date(q.at).toISOString().slice(0, 10) === today).length;
  if (postsToday >= config.maxPostsPerDay) {
    codes.push('daily_cap');
    messages.push(
      `Daily cap reached (${postsToday}/${config.maxPostsPerDay}). Resets at 00:00 UTC.`,
    );
  }

  /* --- per-subreddit weekly cap --- */
  const inTarget = queue.filter((q) => q.subreddit.toLowerCase() === input.subreddit.toLowerCase());
  const lastWeek = [...inTarget]
    .map((q) => differenceInCalendarDays(now, new Date(q.at)))
    .filter((d) => d >= 0 && d < 7)
    .length;
  if (lastWeek >= config.maxPostsPerSubredditPerWeek) {
    codes.push('weekly_cap');
    const oldest = [...inTarget]
      .map((q) => new Date(q.at))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const readyAt = oldest ? new Date(oldest.getTime() + 7 * 24 * 60 * 60 * 1000) : undefined;
    if (readyAt) retryAfter = readyAt.toISOString();
    messages.push(
      `Already posted in r/${input.subreddit} ${lastWeek} time(s) in the last 7 days` +
        (readyAt ? ` — next slot ${readyAt.toISOString()}` : ''),
    );
  }

  /* --- blocklist --- */
  const blocked = config.blocklist.find((b) => b.toLowerCase() === input.subreddit.toLowerCase());
  if (blocked) {
    codes.push('blocklist');
    messages.push(`r/${input.subreddit} is on your blocklist`);
  }

  /* --- cooldown after removal --- */
  const lastRemoval = [...input.history]
    .filter((h) => h.removed && h.subreddit.toLowerCase() === input.subreddit.toLowerCase())
    .map((h) => new Date(h.postedAt))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (lastRemoval) {
    const hoursSince = differenceInHours(now, lastRemoval);
    if (hoursSince < config.cooldownHoursAfterRemoval) {
      codes.push('cooldown');
      const readyAt = new Date(lastRemoval.getTime() + config.cooldownHoursAfterRemoval * 60 * 60 * 1000);
      retryAfter = readyAt.toISOString();
      messages.push(
        `Cooldown active in r/${input.subreddit}: a post was removed ${hoursSince}h ago, waiting ${config.cooldownHoursAfterRemoval}h.`,
      );
    }
  }

  /* --- account age --- */
  if (input.accountAgeDays !== undefined && input.accountAgeDays < config.minAccountAgeDays) {
    codes.push('account_age');
    messages.push(`Account must be ${config.minAccountAgeDays} days old to post here`);
  }

  /* --- prior engagement requirement --- */
  if (config.requirePriorEngagement) {
    const engaged = (input.engagedSubreddits ?? []).some(
      (s) => s.toLowerCase() === input.subreddit.toLowerCase(),
    );
    if (!engaged) {
      codes.push('prior_engagement');
      messages.push(
        `You have never commented in r/${input.subreddit}. Drop a genuinely useful comment there first.`,
      );
    }
  }

  /* --- manual approval --- */
  if (config.requireManualApproval && !isApproved) {
    codes.push('approval');
    messages.push('Manual approval required — this is a setting you can change in Settings.');
  }

  /* --- authenticity gate --- */
  if (
    input.authenticityScore !== undefined &&
    input.authenticityScore < config.minAuthenticityScore
  ) {
    codes.push('authenticity');
    messages.push(
      `Authenticity ${input.authenticityScore} is below your threshold of ${config.minAuthenticityScore}`,
    );
  }

  return {
    allowed: codes.length === 0,
    codes,
    messages,
    ...(retryAfter ? { retryAfter } : {}),
  };
}

/** Weekly posting volume, for the settings UI and the 30-day GTM report. */
export function weeklyVolume(history: readonly PostingHistoryEntry[], now = new Date()): number[] {
  const out = new Array<number>(7).fill(0);
  for (const entry of history) {
    const days = differenceInCalendarDays(now, new Date(entry.postedAt));
    if (days >= 0 && days < 7) out[days] = (out[days] ?? 0) + 1;
  }
  return out;
}

/** Detect whether a cadence would trip a cap. Used to warn before scheduling. */
export function wouldTripCap(
  scheduledTimes: readonly string[],
  config: Partial<GuardrailConfig>,
): boolean {
  const parsed = GuardrailConfigSchema.parse(config ?? {});
  const sorted = [...scheduledTimes].sort();
  const days = new Set(sorted.map((t) => t.slice(0, 10)));
  if (days.size > parsed.maxPostsPerDay * 7) return true;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]!);
    const cur = new Date(sorted[i]!);
    if (differenceInCalendarDays(cur, prev) === 0) return true;
  }
  return false;
}