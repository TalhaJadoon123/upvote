import { and, desc, eq } from 'drizzle-orm';
import { computeLearning, voicePerformanceCorrelation, type PostPerformance } from '@upvote/analytics';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { db } from '@/db';
import { attributionEvents, postMetrics, publishedPosts } from '@/db/schema';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Analytics.
 *
 * The headline chart answers the question the founder actually has: does
 * voice-matched writing outperform? Everything else is supporting evidence.
 */
export default async function AnalyticsPage() {
  const user = await requireUser();

  const posts = await db
    .select()
    .from(publishedPosts)
    .where(eq(publishedPosts.userId, user.id))
    .orderBy(desc(publishedPosts.postedAt))
    .limit(200);

  const postIds = posts.map((p) => p.id);
  const metrics = postIds.length
    ? await db.select().from(postMetrics).where(eq(postMetrics.postId, postIds[0]!))
    : [];
  const events = postIds.length
    ? await db
        .select()
        .from(attributionEvents)
        .where(
          and(
            eq(attributionEvents.userId, user.id),
          ),
        )
        .limit(1000)
    : [];

  const latestByPost = new Map<string, (typeof metrics)[number]>();
  for (const m of metrics) {
    const current = latestByPost.get(m.postId);
    if (!current || m.capturedAt > current.capturedAt) latestByPost.set(m.postId, m);
  }

  const clicksByPost = new Map<string, number>();
  const signupsByPost = new Map<string, { count: number; revenue: number }>();
  for (const event of events) {
    if (!event.postId) continue;
    if (event.kind === 'click') clicksByPost.set(event.postId, (clicksByPost.get(event.postId) ?? 0) + 1);
    if (event.kind === 'signup') {
      const entry = signupsByPost.get(event.postId) ?? { count: 0, revenue: 0 };
      entry.count += 1;
      entry.revenue += event.revenueCents;
      signupsByPost.set(event.postId, entry);
    }
  }

  const rows: PostPerformance[] = posts.map((post) => {
    const snapshot = latestByPost.get(post.id);
    const clicks = clicksByPost.get(post.id) ?? 0;
    const signup = signupsByPost.get(post.id) ?? { count: 0, revenue: 0 };
    return {
      postId: post.id,
      subreddit: post.subreddit,
      title: post.title,
      style: post.style,
      voiceScore: post.voiceScore,
      postedAt: post.postedAt.toISOString(),
      upvotes: snapshot?.upvotes ?? 0,
      comments: snapshot?.comments ?? 0,
      score: snapshot?.score ?? 0,
      upvoteRatio: snapshot?.upvoteRatio ?? 0,
      clicks,
      signups: signup.count,
      revenueCents: signup.revenue,
      ctr: snapshot?.impressions ? clicks / snapshot.impressions : 0,
      clickToSignup: clicks ? signup.count / clicks : 0,
      engagement: (snapshot?.upvotes ?? 0) + (snapshot?.comments ?? 0) * 2.5 + signup.count * 40,
      revenuePerPost: signup.revenue / 100,
    };
  });

  const correlation = voicePerformanceCorrelation(rows);
  const learning = computeLearning({
    posts,
    metrics,
    clicks: [],
    signups: [],
  } as never);

  const totals = rows.reduce(
    (acc, row) => ({
      upvotes: acc.upvotes + row.upvotes,
      comments: acc.comments + row.comments,
      clicks: acc.clicks + row.clicks,
      signups: acc.signups + row.signups,
      revenue: acc.revenue + row.revenueCents,
    }),
    { upvotes: 0, comments: 0, clicks: 0, signups: 0, revenue: 0 },
  );

  const bySubreddit = groupBy(rows, (r) => r.subreddit);
  const byStyle = groupBy(rows, (r) => r.style);
  const maxEngagement = Math.max(1, ...rows.map((r) => r.engagement));

  if (rows.length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Nothing published yet. Once a post goes out, upvotes, comments, clicks and revenue land here.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} published post{rows.length === 1 ? '' : 's'} tracked.
        </p>
      </div>

      <div className="grid-cards">
        <Stat label="Upvotes" value={totals.upvotes.toLocaleString()} />
        <Stat label="Comments" value={totals.comments.toLocaleString()} />
        <Stat label="Tracked clicks" value={totals.clicks.toLocaleString()} />
        <Stat label="Signups" value={totals.signups.toLocaleString()} />
        <Stat label="Revenue" value={`$${(totals.revenue / 100).toFixed(2)}`} />
        <Stat
          label="Avg voice score"
          value={Math.round(rows.reduce((a, r) => a + r.voiceScore, 0) / rows.length).toString()}
        />
        <Stat label="Posts" value={rows.length.toString()} />
        <Stat label="Subreddits" value={bySubreddit.length.toString()} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Does voice match predict upvotes?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-3xl tabular-nums">
              {correlation.coefficient >= 0 ? '+' : ''}
              {correlation.coefficient.toFixed(2)}
            </span>
            <span className="text-sm text-muted-foreground">correlation with engagement</span>
          </div>
          <p className="text-sm text-muted-foreground">{correlation.verdict}</p>
          <div className="space-y-2">
            {correlation.buckets.map((bucket) => {
              const share = bucket.avgEngagement / Math.max(...correlation.buckets.map((b) => b.avgEngagement), 1);
              return (
                <div key={bucket.range} className="flex items-center gap-3 text-xs">
                  <span className="w-16 text-muted-foreground">voice {bucket.range}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-foreground/70"
                      style={{ width: `${share * 100}%` }}
                    />
                  </span>
                  <span className="w-16 text-right font-mono tabular-nums">
                    {bucket.avgEngagement} avg · {bucket.posts} posts
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Best subreddits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {bySubreddit.slice(0, 6).map((row) => (
              <div key={row.key} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 truncate">r/{row.key}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-emerald-500/70"
                    style={{ width: `${(row.engagement / maxEngagement) * 100}%` }}
                  />
                </span>
                <span className="w-8 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.posts}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Winning styles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {byStyle.slice(0, 5).map((row) => (
              <div key={row.key} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 capitalize">{row.key.replace(/_/g, ' ')}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-cyan-500/70"
                    style={{ width: `${(row.engagement / maxEngagement) * 100}%` }}
                  />
                </span>
                <span className="w-8 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.posts}
                </span>
              </div>
            ))}
            {Object.keys(learning.winningStyleBySubreddit).length > 0 && (
              <p className="pt-2 text-xs text-muted-foreground">
                The generator now favours these combinations on the next batch.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Posts</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Post</th>
                <th className="pb-2 font-medium">Sub</th>
                <th className="pb-2 text-right font-medium">Voice</th>
                <th className="pb-2 text-right font-medium">Up</th>
                <th className="pb-2 text-right font-medium">Cmt</th>
                <th className="pb-2 text-right font-medium">Signups</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.postId} className="border-t">
                  <td className="py-2 pr-4">
                    <span className="line-clamp-1">{row.title}</span>
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">r/{row.subreddit}</td>
                  <td className="py-2 text-right font-mono tabular-nums">{row.voiceScore.toFixed(0)}</td>
                  <td className="py-2 text-right font-mono tabular-nums">{row.upvotes}</td>
                  <td className="py-2 text-right font-mono tabular-nums">{row.comments}</td>
                  <td className="py-2 text-right font-mono tabular-nums">{row.signups}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 font-mono text-2xl tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function groupBy<T extends { engagement: number }, K extends string>(rows: readonly T[], key: (row: T) => K) {
  const map = new Map<K, { key: K; engagement: number; posts: number }>();
  for (const row of rows) {
    const k = key(row);
    const entry = map.get(k) ?? { key: k, engagement: 0, posts: 0 };
    entry.engagement += row.engagement;
    entry.posts += 1;
    map.set(k, entry);
  }
  return [...map.values()].sort((a, b) => b.engagement - a.engagement);
}