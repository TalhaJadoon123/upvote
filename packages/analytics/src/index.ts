/**
 * Performance analytics + the learning loop.
 *
 * The loop is the point: measured outcomes (upvotes, clicks, signups, revenue)
 * feed back into (a) which draft style wins in which subreddit, and (b) which
 * hour/day the founder should post. The generator and the scheduler both read
 * these biases, so the product improves with use instead of degrading into
 * generic output.
 */
import {
  PostMetricsSchema,
  attributeStripeEvent,
  buildTrackingLink,
  learnFromHistory,
  styleBiasFromResults,
  weekKey,
  type AttributionSummary,
  type ClickEvent,
  type DraftStyle,
  type PostMetrics,
  type PublishedPost,
  type SignupEvent,
} from '@upvote/core';
import { z } from 'zod';

export * from '@upvote/core';

export const ClickEventSchema = z.object({
  postId: z.string().min(1),
  at: z.string().datetime(),
  referer: z.string().optional(),
});

export const SignupEventSchema = z.object({
  postId: z.string().min(1),
  at: z.string().datetime(),
  revenueCents: z.number().int().optional(),
  userId: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/* In-memory store (the CLI and tests use this; the dashboard uses Drizzle) */
/* ------------------------------------------------------------------ */

export interface AnalyticsStore {
  posts: PublishedPost[];
  metrics: PostMetrics[];
  clicks: ClickEvent[];
  signups: SignupEvent[];
}

export function createStore(): AnalyticsStore {
  return { posts: [], metrics: [], clicks: [], signups: [] };
}

export function recordPost(store: AnalyticsStore, post: PublishedPost): void {
  store.posts.push(post);
}

export function recordMetrics(store: AnalyticsStore, snapshot: PostMetrics): void {
  const parsed = PostMetricsSchema.parse(snapshot);
  const existing = store.metrics.findIndex((m) => m.postId === parsed.postId && m.capturedAt === parsed.capturedAt);
  if (existing >= 0) store.metrics[existing] = parsed;
  else store.metrics.push(parsed);
}

export function recordClick(store: AnalyticsStore, event: ClickEvent): void {
  store.clicks.push(ClickEventSchema.parse(event));
}

export function recordSignup(store: AnalyticsStore, event: SignupEvent): void {
  store.signups.push(SignupEventSchema.parse(event));
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                          */
/* ------------------------------------------------------------------ */

export interface PostPerformance {
  postId: string;
  subreddit: string;
  title: string;
  style: DraftStyle;
  voiceScore: number;
  postedAt: string;
  upvotes: number;
  comments: number;
  score: number;
  upvoteRatio: number;
  clicks: number;
  signups: number;
  revenueCents: number;
  ctr: number;
  clickToSignup: number;
  /** Weighted engagement: upvotes matter more than comments, signups more than both. */
  engagement: number;
  revenuePerPost: number;
}

const ENGAGEMENT_WEIGHTS = { upvote: 1, comment: 2.5, signup: 40 };

/** Latest snapshot per post, plus its attributed clicks/signups. */
export function computePerformance(store: AnalyticsStore): PostPerformance[] {
  return store.posts.map((post) => {
    const snapshots = store.metrics
      .filter((m) => m.postId === post.id)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const latest = snapshots[snapshots.length - 1];
    const clicks = store.clicks.filter((c) => c.postId === post.id).length;
    const signups = store.signups.filter((s) => s.postId === post.id);
    const revenueCents = signups.reduce((a, s) => a + (s.revenueCents ?? 0), 0);
    const upvotes = latest?.upvotes ?? 0;
    const comments = latest?.comments ?? 0;

    return {
      postId: post.id,
      subreddit: post.subreddit,
      title: post.title,
      style: post.style,
      voiceScore: post.voiceScore,
      postedAt: post.postedAt,
      upvotes,
      comments,
      score: latest?.score ?? 0,
      upvoteRatio: latest?.upvoteRatio ?? 0,
      clicks,
      signups: signups.length,
      revenueCents,
      ctr: (latest?.impressions ?? 0) > 0 ? clicks / (latest?.impressions ?? 1) : 0,
      clickToSignup: clicks > 0 ? signups.length / clicks : 0,
      engagement:
        upvotes * ENGAGEMENT_WEIGHTS.upvote +
        comments * ENGAGEMENT_WEIGHTS.comment +
        signups.length * ENGAGEMENT_WEIGHTS.signup,
      revenuePerPost: revenueCents / 100,
    } satisfies PostPerformance;
  });
}

/* ------------------------------------------------------------------ */
/* Dashboard aggregates                                                 */
/* ------------------------------------------------------------------ */

export interface DashboardSummary {
  postsPublished: number;
  totalUpvotes: number;
  totalComments: number;
  totalClicks: number;
  totalSignups: number;
  totalRevenueCents: number;
  avgUpvoteRatio: number;
  avgVoiceScore: number;
  ctr: number;
  /** Upvotes per post. */
  avgUpvotesPerPost: number;
}

export function summarize(store: AnalyticsStore): DashboardSummary {
  const rows = computePerformance(store);
  const impressions = store.metrics
    .filter((m) => m.capturedAt === store.metrics.map((x) => x.capturedAt).sort().at(-1))
    .reduce((a, m) => a + m.impressions, 0);

  const sum = (key: keyof PostPerformance) => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
  return {
    postsPublished: rows.length,
    totalUpvotes: sum('upvotes'),
    totalComments: sum('comments'),
    totalClicks: sum('clicks'),
    totalSignups: sum('signups'),
    totalRevenueCents: sum('revenueCents'),
    avgUpvoteRatio: rows.length ? sum('upvoteRatio') / rows.length : 0,
    avgVoiceScore: rows.length ? sum('voiceScore') / rows.length : 0,
    ctr: impressions > 0 ? sum('clicks') / impressions : 0,
    avgUpvotesPerPost: rows.length ? sum('upvotes') / rows.length : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Rankings - what actually works                                      */
/* ------------------------------------------------------------------ */

export interface RankedGroup<T> {
  key: T;
  posts: number;
  avgUpvotes: number;
  avgEngagement: number;
  totalSignups: number;
  totalRevenueCents: number;
}

export function groupPerformance<T extends string>(
  rows: readonly PostPerformance[],
  key: (row: PostPerformance) => T,
): Array<RankedGroup<T>> {
  const groups = new Map<T, PostPerformance[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k) ?? [];
    list.push(row);
    groups.set(k, list);
  }
  return [...groups.entries()]
    .map(([k, list]) => ({
      key: k,
      posts: list.length,
      avgUpvotes: avg(list.map((r) => r.upvotes)),
      avgEngagement: avg(list.map((r) => r.engagement)),
      totalSignups: list.reduce((a, r) => a + r.signups, 0),
      totalRevenueCents: list.reduce((a, r) => a + r.revenueCents, 0),
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
}

export function bestSubreddits(rows: readonly PostPerformance[]) {
  return groupPerformance(rows, (r) => r.subreddit).slice(0, 10);
}

export function bestStyles(rows: readonly PostPerformance[]) {
  return groupPerformance(rows, (r) => r.style).slice(0, 5);
}

export function bestTitles(rows: readonly PostPerformance[], limit = 10) {
  return [...rows]
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, limit)
    .map((r) => ({ title: r.title, engagement: r.engagement, subreddit: r.subreddit, style: r.style }));
}

/* ------------------------------------------------------------------ */
/* Voice score vs performance — the product's thesis, measured         */
/* ------------------------------------------------------------------ */

export interface VoiceCorrelation {
  /** Pearson correlation between voice score and engagement. -1..1 */
  coefficient: number;
  samples: number;
  /** Plain-language verdict for the dashboard. */
  verdict: string;
  buckets: Array<{ range: string; min: number; posts: number; avgEngagement: number }>;
}

export function voicePerformanceCorrelation(rows: readonly PostPerformance[]): VoiceCorrelation {
  const usable = rows.filter((r) => r.engagement > 0);
  const n = usable.length;
  if (n < 3) {
    return {
      coefficient: 0,
      samples: n,
      verdict: 'Not enough published posts yet to see whether voice match predicts upvotes.',
      buckets: [],
    };
  }

  const xs = usable.map((r) => r.voiceScore);
  const ys = usable.map((r) => r.engagement);
  const mx = avg(xs);
  const my = avg(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (xs[i] ?? 0) - mx;
    const b = (ys[i] ?? 0) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const coefficient = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;

  const buckets = [
    { range: 'under 70', min: 0, max: 70 },
    { range: '70-84', min: 70, max: 85 },
    { range: '85-94', min: 85, max: 95 },
    { range: '95+', min: 95, max: 101 },
  ].map((b) => {
    const inBucket = usable.filter((r) => r.voiceScore >= b.min && r.voiceScore < b.max);
    return {
      range: b.range,
      min: b.min,
      posts: inBucket.length,
      avgEngagement: Math.round(avg(inBucket.map((r) => r.engagement))),
    };
  });

  const verdict =
    coefficient >= 0.5
      ? 'Strong: higher voice match clearly predicts more engagement. Keep the gate at 85.'
      : coefficient >= 0.2
        ? 'Positive: voice-matched posts do better, though other factors matter.'
        : coefficient >= -0.2
          ? 'No clear relationship yet. Keep publishing - the sample is still small.'
          : 'Negative: something other than voice match is driving your results right now.';

  return { coefficient: Math.round(coefficient * 1000) / 1000, samples: n, verdict, buckets };
}

/* ------------------------------------------------------------------ */
/* Learning loop                                                        */
/* ------------------------------------------------------------------ */

export interface LearningState {
  /** subreddit -> 0-1 multiplier used by the matcher. */
  styleBias: Record<string, number>;
  /** Which style won in each subreddit, for the dashboard. */
  winningStyleBySubreddit: Record<string, DraftStyle>;
  learnedHourWeights: number[];
  learnedDayWeights: number[];
  /** Enough data to trust the biases? */
  confident: boolean;
  samples: number;
}

/**
 * Recompute everything the generator and scheduler learn from history.
 * Called after each metrics poll; cheap because it operates on the post list.
 */
export function computeLearning(store: AnalyticsStore): LearningState {
  const rows = computePerformance(store);
  const styleBias = styleBiasFromResults(
    rows.map((r) => ({ subreddit: r.subreddit, style: r.style, engagement: r.engagement })),
  );

  const winningStyleBySubreddit: Record<string, DraftStyle> = {};
  for (const group of groupPerformance(rows, (r) => `${r.subreddit}::${r.style}`)) {
    const [subreddit, style] = group.key.split('::');
    if (!subreddit || !style) continue;
    const current = winningStyleBySubreddit[subreddit];
    const currentScore = current
      ? styleBias[`${subreddit}::${current}`] ?? 0
      : -1;
    const candidate = styleBias[group.key] ?? 0;
    if (!current || candidate > currentScore) {
      winningStyleBySubreddit[subreddit] = style as DraftStyle;
    }
  }

  const timing = learnFromHistory(
    rows.map((r) => ({ postedAt: r.postedAt, engagement: r.engagement })),
  );

  return {
    styleBias,
    winningStyleBySubreddit,
    learnedHourWeights: timing.hourWeights,
    learnedDayWeights: timing.dayWeights,
    confident: rows.length >= 10,
    samples: rows.length,
  };
}

/* ------------------------------------------------------------------ */
/* Weekly report (used by the CLI `analyze` and the digest email)      */
/* ------------------------------------------------------------------ */

export interface WeeklyReport {
  week: string;
  published: PostPerformance[];
  summary: DashboardSummary;
  topSubreddit: RankedGroup<string> | null;
  topStyle: RankedGroup<DraftStyle> | null;
  correlation: VoiceCorrelation;
  learning: LearningState;
  highlights: string[];
  /** What to do differently next week - concrete, not motivational. */
  recommendations: string[];
}

export function buildWeeklyReport(store: AnalyticsStore, now = new Date()): WeeklyReport {
  const thisWeek = weekKey(now, now);
  const published = computePerformance(store)
    .filter((r) => weekKey(r.postedAt, now) === thisWeek)
    .sort((a, b) => b.engagement - a.engagement);

  const summary = summarize(store);
  const subs = groupPerformance(published, (r) => r.subreddit);
  const styles = groupPerformance(published, (r) => r.style);
  const correlation = voicePerformanceCorrelation(computePerformance(store));
  const learning = computeLearning(store);

  const highlights: string[] = [];
  if (published.length > 0) {
    const best = published[0]!;
    highlights.push(`Best post: "${best.title}" in r/${best.subreddit} - ${best.upvotes} upvotes, ${best.signups} signups.`);
    if (best.voiceScore >= 95) highlights.push(`It scored ${best.voiceScore} on voice match. That is the pattern to repeat.`);
  } else {
    highlights.push('Nothing published this week.');
  }
  if (subs[0]) highlights.push(`r/${subs[0].key} is your best subreddit right now (${Math.round(subs[0].avgEngagement)} avg engagement).`);

  const recommendations: string[] = [];
  if (published.length < 2) {
    recommendations.push('Publish at least 2 posts next week - the learning loop needs volume before it can steer generation.');
  }
  if (styles[0] && styles[0].avgEngagement > avg(published.map((r) => r.engagement))) {
    recommendations.push(`Lean into the ${styles[0].key} style in r/${subs[0]?.key ?? 'your best sub'} - it is outperforming your average.`);
  }
  if (correlation.coefficient > 0.3 && published.some((r) => r.voiceScore < 85)) {
    recommendations.push('One post this week slipped below the 85 voice threshold and still went out. That is the leak to plug.');
  }
  if (learning.learnedHourWeights.length > 0 && published.length >= 3) {
    const bestHour = learning.learnedHourWeights.indexOf(Math.max(...learning.learnedHourWeights));
    recommendations.push(`Your posts land best around ${bestHour}:00 UTC - the scheduler now defaults there.`);
  }
  if (summary.totalClicks === 0 && published.length > 0) {
    recommendations.push('No tracked clicks recorded. Confirm the post link carries the UTM parameters or attribution will stay dark.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Nothing to fix. Publish the same style into the same subreddit next week and see if it holds.');
  }

  return {
    week: thisWeek,
    published,
    summary,
    topSubreddit: subs[0] ?? null,
    topStyle: styles[0] ?? null,
    correlation,
    learning,
    highlights,
    recommendations,
  };
}

/* ------------------------------------------------------------------ */
/* Tracking + attribution plumbing                                      */
/* ------------------------------------------------------------------ */

/** Build the link that goes in a post body or first comment. */
export function trackedUrlFor(post: {
  userId: string;
  postId: string;
  subreddit: string;
  style: string;
  baseUrl: string;
  path?: string;
}): string {
  return buildTrackingLink({
    baseUrl: post.baseUrl,
    userId: post.userId,
    postId: post.postId,
    subreddit: post.subreddit,
    style: post.style,
    ...(post.path ? { path: post.path } : {}),
  });
}

/** Attribute a Stripe webhook to a post, falling back to the founder's last click. */
export function attributeRevenueEvent(
  store: AnalyticsStore,
  metadata: Record<string, string | undefined>,
  userId: string,
  revenueCents: number,
): SignupEvent | null {
  const lastClickByUser = new Map<string, ClickEvent>();
  for (const click of [...store.clicks].sort((a, b) => a.at.localeCompare(b.at))) {
    lastClickByUser.set(userId, click);
  }
  const postId = attributeStripeEvent(metadata, lastClickByUser, userId);
  if (!postId) return null;
  const event: SignupEvent = { postId, at: new Date().toISOString(), revenueCents };
  store.signups.push(event);
  return event;
}

/** Per-post attribution summary for the dashboard detail view. */
export function attributionFor(
  store: AnalyticsStore,
  postId: string,
  impressions = 0,
): AttributionSummary {
  const clicks = store.clicks.filter((c) => c.postId === postId);
  const signups = store.signups.filter((s) => s.postId === postId);
  const revenueCents = signups.reduce((a, s) => a + (s.revenueCents ?? 0), 0);
  return {
    postId,
    impressions,
    clicks: clicks.length,
    signups: signups.length,
    revenueCents,
    ctr: impressions > 0 ? Math.round((clicks.length / impressions) * 10000) / 10000 : 0,
    clickToSignup: clicks.length > 0 ? Math.round((signups.length / clicks.length) * 10000) / 10000 : 0,
    revenuePerPost: Math.round((revenueCents / 100) * 100) / 100,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function avg(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}