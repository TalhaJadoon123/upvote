import { describe, expect, it } from 'vitest';
import {
  attributionFor,
  attributeRevenueEvent,
  attributionRevenue,
  bestStyles,
  bestSubreddits,
  buildWeeklyReport,
  computeLearning,
  computePerformance,
  createStore,
  groupPerformance,
  recordClick,
  recordMetrics,
  recordPost,
  recordSignup,
  summarize,
  trackedUrlFor,
  voicePerformanceCorrelation,
  type AnalyticsStore,
} from '@upvote/analytics';
import type { PublishedPost } from '@upvote/core';

const BASE = new Date('2026-01-07T12:00:00.000Z');

function post(overrides: Partial<PublishedPost> = {}): PublishedPost {
  return {
    id: 'p1',
    userId: 'u1',
    draftId: 'd1',
    subreddit: 'programming',
    redditId: 't3_abc',
    permalink: 'https://reddit.com/r/programming/comments/abc/x/',
    title: 'the retry cache was the bug',
    style: 'story',
    voiceScore: 92,
    postedAt: BASE.toISOString(),
    trackedUrl: null,
    ...overrides,
  };
}

function seeded(): AnalyticsStore {
  const store = createStore();
  recordPost(store, post());
  recordMetrics(store, {
    postId: 'p1',
    capturedAt: BASE.toISOString(),
    upvotes: 80,
    downvotes: 2,
    comments: 12,
    score: 78,
    upvoteRatio: 80 / 82,
    impressions: 4000,
    clicks: 40,
    signups: 0,
    revenueCents: 0,
  });
  return store;
}

describe('store', () => {
  it('starts empty', () => {
    const store = createStore();
    expect(store.posts).toEqual([]);
    expect(summarize(store).postsPublished).toBe(0);
  });

  it('validates metric snapshots', () => {
    const store = createStore();
    expect(() => recordMetrics(store, { postId: '' } as never)).toThrow();
  });

  it('is idempotent for the same post + timestamp', () => {
    const store = seeded();
    const before = store.metrics.length;
    recordMetrics(store, { ...store.metrics[0]!, upvotes: 999 });
    expect(store.metrics).toHaveLength(before);
  });

  it('validates click and signup events', () => {
    const store = createStore();
    expect(() => recordClick(store, { postId: '', at: 'nope' })).toThrow();
    expect(() => recordSignup(store, { postId: '', at: 'nope' })).toThrow();
  });
});

describe('computePerformance', () => {
  it('joins the latest snapshot with attributed events', () => {
    const store = seeded();
    recordClick(store, { postId: 'p1', at: BASE.toISOString() });
    recordSignup(store, { postId: 'p1', at: BASE.toISOString(), revenueCents: 1900 });
    const [row] = computePerformance(store);
    expect(row?.upvotes).toBe(80);
    expect(row?.clicks).toBe(1);
    expect(row?.signups).toBe(1);
    expect(row?.revenueCents).toBe(1900);
    expect(row?.revenuePerPost).toBe(19);
  });

  it('uses the newest snapshot when several exist', () => {
    const store = seeded();
    recordMetrics(store, {
      postId: 'p1',
      capturedAt: '2026-01-07T18:00:00.000Z',
      upvotes: 150,
      downvotes: 3,
      comments: 20,
      score: 147,
      upvoteRatio: 0.98,
      impressions: 9000,
      clicks: 0,
      signups: 0,
      revenueCents: 0,
    });
    expect(computePerformance(store)[0]?.upvotes).toBe(150);
  });

  it('weights engagement by what a founder actually cares about', () => {
    const low = { ...post({ id: 'a' }), };
    const store = createStore();
    recordPost(store, low);
    recordMetrics(store, {
      postId: 'a', capturedAt: BASE.toISOString(), upvotes: 10, downvotes: 0, comments: 1,
      score: 10, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
    });
    const other = createStore();
    recordPost(other, post({ id: 'b' }));
    recordMetrics(other, {
      postId: 'b', capturedAt: BASE.toISOString(), upvotes: 10, downvotes: 0, comments: 1,
      score: 10, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
    });
    recordSignup(other, { postId: 'b', at: BASE.toISOString(), revenueCents: 0 });
    expect(computePerformance(other)[0]!.engagement).toBeGreaterThan(computePerformance(store)[0]!.engagement);
  });

  it('computes CTR and click-to-signup', () => {
    const store = seeded();
    recordClick(store, { postId: 'p1', at: BASE.toISOString() });
    recordClick(store, { postId: 'p1', at: BASE.toISOString() });
    recordSignup(store, { postId: 'p1', at: BASE.toISOString() });
    const [row] = computePerformance(store);
    expect(row?.ctr).toBeCloseTo(2 / 4000, 4);
    expect(row?.clickToSignup).toBeCloseTo(0.5, 4);
  });
});

describe('summarize', () => {
  it('rolls up totals', () => {
    const store = seeded();
    recordClick(store, { postId: 'p1', at: BASE.toISOString() });
    const summary = summarize(store);
    expect(summary.postsPublished).toBe(1);
    expect(summary.totalUpvotes).toBe(80);
    expect(summary.totalClicks).toBe(1);
    expect(summary.avgUpvotesPerPost).toBe(80);
    expect(summary.avgVoiceScore).toBe(92);
  });

  it('handles an empty store without NaN', () => {
    const summary = summarize(createStore());
    expect(summary.avgUpvoteRatio).toBe(0);
    expect(summary.ctr).toBe(0);
  });
});

describe('rankings', () => {
  function twoSubredditStore(): AnalyticsStore {
    const store = createStore();
    recordPost(store, post({ id: 'a', subreddit: 'programming', style: 'story' }));
    recordMetrics(store, {
      postId: 'a', capturedAt: BASE.toISOString(), upvotes: 100, downvotes: 0, comments: 5,
      score: 100, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
    });
    recordPost(store, post({ id: 'b', subreddit: 'webdev', style: 'data' }));
    recordMetrics(store, {
      postId: 'b', capturedAt: BASE.toISOString(), upvotes: 10, downvotes: 0, comments: 60,
      score: 10, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
    });
    return store;
  }

  it('ranks subreddits by engagement', () => {
    const ranked = bestSubreddits(computePerformance(twoSubredditStore()));
    expect(ranked[0]?.key).toBe('webdev');
    expect(ranked[0]?.avgEngagement).toBeGreaterThan(ranked[1]?.avgEngagement ?? 0);
  });

  it('ranks styles by engagement', () => {
    const ranked = bestStyles(computePerformance(twoSubredditStore()));
    expect(ranked.map((r) => r.key)).toContain('data');
    expect(ranked.length).toBe(2);
  });

  it('groups by an arbitrary key', () => {
    const grouped = groupPerformance(computePerformance(twoSubredditStore()), (r) =>
      r.engagement > 130 ? 'hit' : 'miss',
    );
    expect(grouped.map((g) => g.key)).toEqual(['hit', 'miss']);
    expect(grouped[0]?.posts).toBe(1);
  });
});

describe('voicePerformanceCorrelation', () => {
  it('needs data before it will claim anything', () => {
    const result = voicePerformanceCorrelation([]);
    expect(result.samples).toBe(0);
    expect(result.verdict).toMatch(/Not enough/i);
  });

  it('detects a positive relationship', () => {
    const store = createStore();
    for (let i = 0; i < 6; i++) {
      const id = `p${i}`;
      recordPost(store, post({ id, voiceScore: 70 + i * 5 }));
      recordMetrics(store, {
        postId: id, capturedAt: BASE.toISOString(), upvotes: (i + 1) * 10, downvotes: 0,
        comments: 0, score: 0, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
      });
    }
    const result = voicePerformanceCorrelation(computePerformance(store));
    expect(result.coefficient).toBeGreaterThan(0.9);
    expect(result.verdict).toMatch(/Strong/i);
    expect(result.buckets).toHaveLength(4);
  });

  it('reports no relationship when the data says otherwise', () => {
    const store = createStore();
    // Voice score ascending while upvotes descend: deliberately uncorrelated.
    const scores = [70, 72, 75, 88, 91, 95];
    const upvotes = [400, 350, 300, 20, 30, 10];
    for (let i = 0; i < scores.length; i++) {
      const id = `p${i}`;
      recordPost(store, post({ id, voiceScore: scores[i] ?? 80 }));
      recordMetrics(store, {
        postId: id, capturedAt: BASE.toISOString(), upvotes: upvotes[i] ?? 0, downvotes: 0,
        comments: 0, score: 0, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
      });
    }
    const result = voicePerformanceCorrelation(computePerformance(store));
    expect(result.coefficient).toBeLessThan(-0.9);
    expect(result.verdict).toMatch(/Negative/i);
  });
});

describe('learning loop', () => {
  it('produces subreddit style biases from history', () => {
    const store = createStore();
    for (let i = 0; i < 3; i++) {
      recordPost(store, post({ id: `s${i}`, subreddit: 'programming', style: 'story' }));
      recordMetrics(store, {
        postId: `s${i}`, capturedAt: BASE.toISOString(), upvotes: 100 - i, downvotes: 0, comments: 0,
        score: 0, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
      });
    }
    const learning = computeLearning(store);
    expect(learning.styleBias.programming).toBeGreaterThan(0.5);
    expect(learning.winningStyleBySubreddit.programming).toBe('story');
    expect(learning.confident).toBe(false);
    expect(learning.samples).toBe(3);
  });

  it('marks itself confident with enough posts', () => {
    const store = createStore();
    for (let i = 0; i < 11; i++) {
      recordPost(store, post({ id: `p${i}` }));
      recordMetrics(store, {
        postId: `p${i}`, capturedAt: BASE.toISOString(), upvotes: 10 + i, downvotes: 0, comments: 0,
        score: 0, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
      });
    }
    expect(computeLearning(store).confident).toBe(true);
  });

  it('learns hour-of-day weights from the founder history', () => {
    const store = createStore();
    // Two great posts at 14:00 UTC, two duds at 03:00 UTC.
    for (const [i, hour] of [14, 14, 3, 3].entries()) {
      const id = `p${i}`;
      const when = new Date(Date.UTC(2026, 0, 7, hour as number, 5));
      recordPost(store, post({ id, postedAt: when.toISOString() }));
      recordMetrics(store, {
        postId: id, capturedAt: when.toISOString(), upvotes: hour === 14 ? 200 : 2, downvotes: 0,
        comments: 0, score: 0, upvoteRatio: 1, impressions: 0, clicks: 0, signups: 0, revenueCents: 0,
      });
    }
    const learning = computeLearning(store);
    expect(learning.learnedHourWeights).toHaveLength(24);
    expect(learning.learnedHourWeights[14]).toBeGreaterThan(learning.learnedHourWeights[3] ?? 0);
  });
});

describe('buildWeeklyReport', () => {
  it('reports an empty week honestly', () => {
    const report = buildWeeklyReport(createStore(), BASE);
    expect(report.published).toHaveLength(0);
    expect(report.highlights).toContain('Nothing published this week.');
    expect(report.recommendations[0]).toMatch(/Publish at least 2 posts/);
  });

  it('summarises a good week with next actions', () => {
    const store = seeded();
    recordClick(store, { postId: 'p1', at: BASE.toISOString() });
    recordSignup(store, { postId: 'p1', at: BASE.toISOString(), revenueCents: 1900 });
    const report = buildWeeklyReport(store, BASE);
    expect(report.published).toHaveLength(1);
    expect(report.highlights[0]).toContain('Best post');
    expect(report.topSubreddit?.key).toBe('programming');
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('warns when attribution is dark', () => {
    const store = seeded();
    const report = buildWeeklyReport(store, BASE);
    expect(report.recommendations.join(' ')).toMatch(/UTM|no tracked clicks/i);
  });
});

describe('tracking links', () => {
  it('builds a UTM link carrying a short click id', () => {
    const url = new URL(
      trackedUrlFor({
        userId: 'u1',
        postId: 'p1',
        subreddit: 'programming',
        style: 'story',
        baseUrl: 'acme.dev',
        path: 'pricing',
      }),
    );
    expect(url.searchParams.get('utm_source')).toBe('upvote');
    expect(url.searchParams.get('utm_medium')).toBe('reddit');
    expect(url.searchParams.get('utm_campaign')).toBe('programming');
    expect(url.searchParams.get('utm_content')).toBe('story');
    expect(url.searchParams.get('upv')).toHaveLength(10);
    expect(url.pathname).toBe('/pricing');
  });

  it('is deterministic for the same post', () => {
    const args = { userId: 'u1', postId: 'p1', subreddit: 'r', style: 's', baseUrl: 'https://acme.dev' };
    expect(trackedUrlFor(args)).toBe(trackedUrlFor(args));
  });

  it('handles a base URL with a trailing slash', () => {
    expect(trackedUrlFor({ userId: 'u', postId: 'p', subreddit: 'r', style: 's', baseUrl: 'https://acme.dev/' })).toContain('https://acme.dev/?');
  });
});

describe('revenue attribution', () => {
  it('uses the Stripe metadata when present', () => {
    const store = createStore();
    const event = attributeRevenueEvent(store, { upv_post: 'p1' }, 'u1', 1900);
    expect(event?.postId).toBe('p1');
    expect(store.signups).toHaveLength(1);
  });

  it('falls back to the last click', () => {
    const store = createStore();
    recordClick(store, { postId: 'p9', at: '2026-01-01T00:00:00.000Z' });
    const event = attributeRevenueEvent(store, {}, 'u1', 1900);
    expect(event?.postId).toBe('p9');
  });

  it('returns null when there is nothing to attribute to', () => {
    expect(attributeRevenueEvent(createStore(), {}, 'u1', 1900)).toBeNull();
  });

  it('exposes a per-post attribution summary', () => {
    const store = seeded();
    recordClick(store, { postId: 'p1', at: BASE.toISOString() });
    recordClick(store, { postId: 'p1', at: BASE.toISOString() });
    recordSignup(store, { postId: 'p1', at: BASE.toISOString(), revenueCents: 1900 });
    const summary = attributionFor(store, 'p1', 4000);
    expect(summary.clicks).toBe(2);
    expect(summary.signups).toBe(1);
    expect(summary.revenuePerPost).toBe(19);
    expect(summary.ctr).toBeCloseTo(0.0005, 4);
  });
});

describe('attributionRevenue helper', () => {
  it('sums revenue for a post', () => {
    const store = createStore();
    recordSignup(store, { postId: 'p1', at: BASE.toISOString(), revenueCents: 1900 });
    recordSignup(store, { postId: 'p1', at: BASE.toISOString(), revenueCents: 500 });
    expect(attributionRevenue(store, 'p1')).toBe(2400);
  });
});