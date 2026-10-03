/**
 * Posting scheduler.
 *
 * Two layers:
 *  - Pure scheduling logic (this file): pick a slot, respect the queue, decide
 *    what is due. Fully testable with an injected clock.
 *  - `queue.ts`: optional BullMQ + Redis worker for production deployments.
 *    The pure layer is the source of truth; BullMQ just wakes it up.
 */
import {
  GuardrailConfigSchema,
  predictBestTimes,
  type Draft,
  type GuardrailConfig,
  type PostingHistoryEntry,
  type SubredditProfile,
  type TimeSlot,
} from '@upvote/core';
import { differenceInCalendarDays } from '@upvote/core';

export interface ScheduledItem {
  draftId: string;
  userId: string;
  subreddit: string;
  /** When it should go out. */
  runAt: string;
  /** Why this slot was chosen - surfaced in the dashboard. */
  reason: string;
  attempts: number;
  lastError?: string;
  status: 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';
}

export interface SchedulerState {
  items: ScheduledItem[];
  history: PostingHistoryEntry[];
  config: GuardrailConfig;
}

export interface ScheduleOptions {
  now?: Date;
  /** Subreddit activity data, when we have it. */
  subreddits?: SubredditProfile[];
  /** Learned hour/day weights from the founder's own history. */
  learnedHourWeights?: number[];
  learnedDayWeights?: number[];
  /** Slots already taken by other drafts. */
  occupiedSlots?: string[];
}

/* ------------------------------------------------------------------ */
/* Slot selection                                                       */
/* ------------------------------------------------------------------ */

/**
 * Choose when to post a draft.
 *
 * Preference order:
 *  1. The best subreddit's predicted peak, if that slot is free.
 *  2. The next best subreddit's peak.
 *  3. The draft's own suggested window.
 *  4. The next even top-of-hour, as a floor so nothing is ever unschedulable.
 */
export function chooseSlot(
  draft: Draft,
  options: ScheduleOptions = {},
): { slot: TimeSlot; subreddit: string | null; fallback: boolean } {
  const now = options.now ?? new Date();
  const occupied = new Set(options.occupiedSlots ?? []);

  const candidates = draft.suggestedSubreddits
    .filter((s) => s.compliant)
    .map((suggestion) => {
      const profile = options.subreddits?.find((p) => p.name === suggestion.subreddit);
      const slots = profile
        ? predictBestTimes(profile, {
            count: 3,
            now,
            ...(options.learnedHourWeights ? { learnedHourWeights: options.learnedHourWeights } : {}),
            ...(options.learnedDayWeights ? { learnedDayWeights: options.learnedDayWeights } : {}),
          })
        : [];
      return { suggestion, slots };
    })
    .filter((c) => c.slots.length > 0)
    .sort((a, b) => b.suggestion.fit - a.suggestion.fit);

  for (const candidate of candidates) {
    const free = candidate.slots.find((s) => !occupied.has(s.at));
    if (free) return { slot: free, subreddit: candidate.suggestion.subreddit, fallback: false };
  }

  // A draft's own scheduledFor is the fallback the generator already computed.
  if (draft.scheduledFor) {
    return {
      slot: { at: draft.scheduledFor, score: 0.5, reason: 'draft default window' },
      subreddit: draft.primarySubreddit,
      fallback: true,
    };
  }

  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return {
    slot: { at: next.toISOString(), score: 0.1, reason: 'next hour - no better slot available' },
    subreddit: draft.primarySubreddit,
    fallback: true,
  };
}

/* ------------------------------------------------------------------ */
/* Queue operations                                                     */
/* ------------------------------------------------------------------ */

/**
 * Add a draft to the queue.
 *
 * Walks the candidate slots in preference order and takes the first one that is
 * both free and legal under the guardrails (weekly per-subreddit cap). The item
 * is pushed onto `state.items` so the queue can never double-book itself.
 * Returns null when nothing can be scheduled.
 */
export function scheduleDraft(
  state: SchedulerState,
  draft: Draft,
  options: ScheduleOptions = {},
): ScheduledItem | null {
  const now = options.now ?? new Date();
  const config = GuardrailConfigSchema.parse(state.config ?? {});

  const targetSubreddit = draft.primarySubreddit;
  if (!targetSubreddit) return null;

  const occupied = new Set([
    ...(options.occupiedSlots ?? []),
    ...state.items.filter((i) => i.status === 'scheduled').map((i) => i.runAt),
  ]);

  const takenInSub = state.items.filter(
    (item) =>
      item.subreddit.toLowerCase() === targetSubreddit.toLowerCase() &&
      item.status === 'scheduled',
  );

  /** Would posting at this time breach the weekly cap for this subreddit? */
  const breachesWeeklyCap = (iso: string): boolean => {
    const candidate = new Date(iso);
    const withinWeek = takenInSub.filter((item) => {
      const delta = Math.abs(candidate.getTime() - new Date(item.runAt).getTime());
      return delta < 7 * 86_400_000;
    });
    return withinWeek.length >= config.maxPostsPerSubredditPerWeek;
  };

  // Build every legal slot we could use, best first.
  const candidates = draft.suggestedSubreddits
    .filter((s) => s.compliant)
    .sort((a, b) => b.fit - a.fit)
    .flatMap((suggestion) => {
      const profile = options.subreddits?.find((p) => p.name === suggestion.subreddit);
      if (!profile) return [];
      const slots = predictBestTimes(profile, {
        count: 5,
        now,
        ...(options.learnedHourWeights ? { learnedHourWeights: options.learnedHourWeights } : {}),
        ...(options.learnedDayWeights ? { learnedDayWeights: options.learnedDayWeights } : {}),
      });
      return slots.map((slot) => ({ slot, subreddit: suggestion.subreddit }));
    })
    .sort((a, b) => b.slot.score - a.slot.score);

  for (const candidate of candidates) {
    if (occupied.has(candidate.slot.at)) continue;
    if (breachesWeeklyCap(candidate.slot.at)) continue;
    const item: ScheduledItem = {
      draftId: draft.id,
      userId: draft.userId,
      subreddit: candidate.subreddit,
      runAt: candidate.slot.at,
      reason: `${candidate.slot.reason} (${candidate.subreddit})`,
      attempts: 0,
      status: 'scheduled',
    };
    state.items.push(item);
    return item;
  }

  // Nothing cleared the bar: fall back to the draft's own suggested window.
  if (draft.scheduledFor && !occupied.has(draft.scheduledFor) && !breachesWeeklyCap(draft.scheduledFor)) {
    const item: ScheduledItem = {
      draftId: draft.id,
      userId: draft.userId,
      subreddit: targetSubreddit,
      runAt: draft.scheduledFor,
      reason: `draft default window (${targetSubreddit})`,
      attempts: 0,
      status: 'scheduled',
    };
    state.items.push(item);
    return item;
  }

  return null;
}

/** Items whose time has come, oldest first. */
export function dueItems(state: SchedulerState, now = new Date()): ScheduledItem[] {
  return state.items
    .filter((item) => item.status === 'scheduled' && new Date(item.runAt).getTime() <= now.getTime())
    .sort((a, b) => a.runAt.localeCompare(b.runAt));
}

/** The next N upcoming items, soonest first. */
export function upcoming(state: SchedulerState, now = new Date(), limit = 10): ScheduledItem[] {
  return state.items
    .filter((item) => item.status === 'scheduled' && new Date(item.runAt).getTime() > now.getTime())
    .sort((a, b) => a.runAt.localeCompare(b.runAt))
    .slice(0, limit);
}

/** Mark an item as in-flight so a second worker cannot double-post it. */
export function claimItem(state: SchedulerState, draftId: string): ScheduledItem | null {
  const item = state.items.find((i) => i.draftId === draftId && i.status === 'scheduled');
  if (!item) return null;
  item.status = 'publishing';
  return item;
}

export function completeItem(state: SchedulerState, draftId: string, redditId: string, now = new Date()): PostingHistoryEntry | null {
  const item = state.items.find((i) => i.draftId === draftId);
  if (!item) return null;
  item.status = 'published';
  const entry: PostingHistoryEntry = {
    userId: item.userId,
    subreddit: item.subreddit,
    postedAt: now.toISOString(),
    postId: redditId,
    removed: false,
  };
  state.history.push(entry);
  return entry;
}

export function failItem(
  state: SchedulerState,
  draftId: string,
  error: string,
  options: { maxAttempts?: number; retryDelayMinutes?: number } = {},
): { retryAt: string | null; exhausted: boolean } {
  const item = state.items.find((i) => i.draftId === draftId);
  if (!item) return { retryAt: null, exhausted: true };
  item.attempts += 1;
  item.lastError = error;

  const maxAttempts = options.maxAttempts ?? 3;
  if (item.attempts >= maxAttempts) {
    item.status = 'failed';
    return { retryAt: null, exhausted: true };
  }

  // Exponential backoff, with a floor so a transient Reddit blip isn't fatal.
  const delay = (options.retryDelayMinutes ?? 15) * 2 ** (item.attempts - 1);
  const retryAt = new Date(Date.now() + delay * 60_000);
  item.runAt = retryAt.toISOString();
  item.status = 'scheduled';
  return { retryAt: retryAt.toISOString(), exhausted: false };
}

/**
 * Record that Reddit removed a post. This starts the cooldown that keeps the
 * same subreddit from being posted to again for a configurable window.
 */
export function markRemoved(state: SchedulerState, postId: string): void {
  const entry = state.history.find((h) => h.postId === postId);
  if (entry) entry.removed = true;
}

/* ------------------------------------------------------------------ */
/* Calendar                                                             */
/* ------------------------------------------------------------------ */

export interface CalendarDay {
  date: string;
  items: ScheduledItem[];
  /** 0-100, how loaded the day is against the guardrails. */
  load: number;
  blocked: boolean;
}

/** Group the queue into a calendar for the dashboard's month view. */
export function buildCalendar(
  state: SchedulerState,
  options: { from?: Date; days?: number } = {},
): CalendarDay[] {
  const config = GuardrailConfigSchema.parse(state.config ?? {});
  const from = options.from ?? new Date();
  const days = options.days ?? 30;
  const out: CalendarDay[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(from.getTime() + i * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    const items = state.items.filter((item) => item.runAt.slice(0, 10) === key && item.status === 'scheduled');
    out.push({
      date: key,
      items,
      load: Math.min(100, (items.length / config.maxPostsPerDay) * 100),
      blocked: items.length >= config.maxPostsPerDay,
    });
  }
  return out;
}

/** Human summary of the queue state for the CLI. */
export function describeQueue(state: SchedulerState, now = new Date()): string {
  const scheduled = state.items.filter((i) => i.status === 'scheduled').length;
  const failed = state.items.filter((i) => i.status === 'failed').length;
  const next = upcoming(state, now, 1)[0];
  const postedThisWeek = state.history.filter(
    (h) => differenceInCalendarDays(now, new Date(h.postedAt)) < 7,
  ).length;
  return [
    `${scheduled} scheduled`,
    failed > 0 ? `${failed} failed` : null,
    next ? `next: ${next.subreddit} at ${next.runAt}` : null,
    `${postedThisWeek} posted in the last 7 days`,
  ]
    .filter(Boolean)
    .join(' | ');
}