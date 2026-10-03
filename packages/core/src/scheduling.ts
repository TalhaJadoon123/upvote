/**
 * Best-time-to-post predictor.
 *
 * Reddit's audience is overwhelmingly US/UK timezone-driven, and activity is
 * strongly bimodal (morning commute + evening scroll). When we have observed
 * per-subreddit hourly data we use it; otherwise we fall back to priors derived
 * from subreddit size and region, then personalize by the founder's own history.
 */
import type { SubredditProfile } from './types.js';
import { clamp, round, unique } from './utils.js';

export interface TimeSlot {
  /** UTC ISO timestamp. */
  at: string;
  /** 0-1. */
  score: number;
  /** Why we picked this slot — shown in the dashboard. */
  reason: string;
}

export interface PredictOptions {
  /** Founder's UTC offset in minutes (e.g. -240 for EDT). */
  userOffsetMinutes?: number;
  /** Subreddit's declared timezone offset in minutes, if known. */
  subredditOffsetMinutes?: number;
  /** How many slots to return. */
  count?: number;
  /** How far ahead to look. */
  horizonDays?: number;
  /** `now` injectable for deterministic tests. */
  now?: Date;
  /** Learned: hour-of-day -> relative performance (0-1), from the founder's own posts. */
  learnedHourWeights?: number[];
  /** Learned: day-of-week -> relative performance (0-1), 0 = Sunday. */
  learnedDayWeights?: number[];
}

const HOUR_PRIOR = [
  0.14, 0.1, 0.08, 0.07, 0.07, 0.11, 0.2, 0.36, 0.52, 0.6, 0.58, 0.55, 0.54, 0.55, 0.56, 0.58,
  0.62, 0.68, 0.75, 0.82, 0.86, 0.8, 0.62, 0.38,
];

const DAY_PRIOR = [0.82, 0.98, 1.0, 1.02, 1.0, 0.94, 0.86];

/** Smaller, tighter communities behave differently from the big front pages. */
const SMALL_SUB_SHIFT = { peakShiftHours: 2, weekendBoost: 0.12, scale: 0.85 };

export function hourWeightsFor(subreddit: SubredditProfile): { weights: number[]; reason: string } {
  const observed = subreddit.activityByHourUtc;
  if (observed.length === 24) {
    const max = Math.max(...observed);
    if (max > 0) {
      return {
        weights: observed.map((v) => clamp(v / max)),
        reason: `observed activity for r/${subreddit.name}`,
      };
    }
  }

  const size = subreddit.subscribers ?? 10_000;
  if (size < 20_000) {
    return {
      weights: shiftHours(HOUR_PRIOR, SMALL_SUB_SHIFT.peakShiftHours).map((v) => clamp(v * SMALL_SUB_SHIFT.scale)),
      reason: 'small-subreddit prior (people browse in the evening)',
    };
  }
  return { weights: HOUR_PRIOR, reason: 'general Reddit activity prior' };
}

function shiftHours(weights: readonly number[], hours: number): number[] {
  const out = new Array<number>(24).fill(0);
  for (let i = 0; i < 24; i++) out[i] = weights[(i - hours + 24) % 24] ?? 0;
  return out;
}

/**
 * Rank candidate posting slots in the next `horizonDays`.
 * Combines: subreddit hourly curve · day-of-week curve · founder's learned weights.
 */
export function predictBestTimes(
  subreddit: SubredditProfile,
  options: PredictOptions = {},
): TimeSlot[] {
  const now = options.now ?? new Date();
  const count = options.count ?? 3;
  const horizonDays = options.horizonDays ?? 7;
  const { weights: baseWeights, reason } = hourWeightsFor(subreddit);
  const isSmall = (subreddit.subscribers ?? 0) < 20_000;

  const hourWeights = baseWeights.map((prior, i) => {
    const learned = options.learnedHourWeights?.[i];
    // The dead zone suppresses the *prior* only. If the founder's own history
    // says 3am works for them, we believe them - they have the real data.
    const gated = i >= 2 && i <= 5 ? prior * 0.25 : prior;
    if (learned === undefined) return gated;
    // Learned data, when supplied, is the stronger signal.
    return gated * 0.4 + clamp(learned) * 0.6;
  });

  const slots: TimeSlot[] = [];

  for (let d = 0; d < horizonDays; d++) {
    const dayStart = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const dayOfWeek = dayStart.getUTCDay();

    let dayWeight = DAY_PRIOR[dayOfWeek] ?? 1;
    if (isSmall && (dayOfWeek === 0 || dayOfWeek === 6)) dayWeight += SMALL_SUB_SHIFT.weekendBoost;
    const learnedDay = options.learnedDayWeights?.[dayOfWeek];
    if (learnedDay !== undefined) dayWeight = dayWeight * 0.4 + clamp(learnedDay) * 0.6;

    for (let hour = 0; hour < 24; hour++) {
      const candidate = new Date(
        Date.UTC(
          dayStart.getUTCFullYear(),
          dayStart.getUTCMonth(),
          dayStart.getUTCDate(),
          hour,
          roundMinuteOffset(),
        ),
      );
      // Skip slots we could not actually schedule in time.
      const leadMs = candidate.getTime() - now.getTime();
      if (leadMs < 30 * 60 * 1000) continue;

      const hourWeight = hourWeights[hour] ?? 0;
      const score = clamp(hourWeight * dayWeight);

      slots.push({
        at: candidate.toISOString(),
        score: round(score, 4),
        reason: buildReason(hour, subreddit, reason, isSmall),
      });
    }
  }

  // Pick top scores but keep at least 6h between slots so the queue does not clump.
  const sorted = slots.sort((a, b) => b.score - a.score);
  const picked: TimeSlot[] = [];
  for (const slot of sorted) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(new Date(p.at).getTime() - new Date(slot.at).getTime()) > 6 * 60 * 60 * 1000)) {
      picked.push(slot);
    }
  }
  return picked.sort((a, b) => a.at.localeCompare(b.at));
}

function roundMinuteOffset(): number {
  return 5;
}

function buildReason(hour: number, subreddit: SubredditProfile, basis: string, isSmall: boolean): string {
  const local = isSmall ? hour + SMALL_SUB_SHIFT.peakShiftHours : hour;
  const label = describeHour((local % 24 + 24) % 24);
  return `${label} UTC — ${basis} · ${subreddit.subscribers ? `${compact(subreddit.subscribers)} subs` : 'size unknown'}`;
}

export function describeHour(hourUtc: number): string {
  const h = ((hourUtc % 24) + 24) % 24;
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${round(n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${round(n / 1_000, n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Convert a UTC instant to a human local time for display. */
export function formatInUserTimezone(iso: string, offsetMinutes = 0): string {
  const shifted = new Date(new Date(iso).getTime() + offsetMinutes * 60_000);
  const hour = describeHour(shifted.getUTCHours());
  const day = shifted.toISOString().slice(0, 10);
  const sign = offsetMinutes <= 0 ? 'UTC' : `UTC+${Math.round(offsetMinutes / 60)}`;
  return `${day} ${hour} ${offsetMinutes === 0 ? sign : `(${sign})`}`;
}

/**
 * Learn hour/day weights from the founder's own published posts.
 * `engagement` is upvotes+comments, or normalized CTR when available.
 */
export function learnFromHistory(
  posts: ReadonlyArray<{ postedAt: string; engagement: number }>,
): { hourWeights: number[]; dayWeights: number[]; samples: number } {
  const hourTotals = new Array<number>(24).fill(0);
  const hourCounts = new Array<number>(24).fill(0);
  const dayTotals = new Array<number>(7).fill(0);
  const dayCounts = new Array<number>(7).fill(0);

  let max = 0;
  for (const post of posts) {
    max = Math.max(max, post.engagement);
    const date = new Date(post.postedAt);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    hourTotals[hour] = (hourTotals[hour] ?? 0) + post.engagement;
    hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
    dayTotals[day] = (dayTotals[day] ?? 0) + post.engagement;
    dayCounts[day] = (dayCounts[day] ?? 0) + 1;
  }
  if (max === 0) return { hourWeights: [], dayWeights: [], samples: 0 };

  const hourWeights = hourTotals.map((total, i) =>
    hourCounts[i] === 0 ? 0 : clamp((total / (hourCounts[i] ?? 1)) / max),
  );
  const dayWeights = dayTotals.map((total, i) =>
    dayCounts[i] === 0 ? 0 : clamp((total / (dayCounts[i] ?? 1)) / max),
  );
  return { hourWeights, dayWeights, samples: posts.length };
}

/** All distinct hour/day pairs the predictor would ever choose — used to render a heatmap. */
export function heatmap(): Array<{ day: number; hour: number; score: number }> {
  const rows: Array<{ day: number; hour: number; score: number }> = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      rows.push({ day, hour, score: round(clamp((HOUR_PRIOR[hour] ?? 0) * (DAY_PRIOR[day] ?? 1)), 3) });
    }
  }
  return rows;
}

/** Dedupe helper re-exported for callers building slot lists. */
export function uniqueSlots(slots: readonly TimeSlot[]): TimeSlot[] {
  return unique(slots.map((s) => s.at)).map((at) => slots.find((s) => s.at === at)!);
}