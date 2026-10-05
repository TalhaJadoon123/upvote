import { NextRequest } from 'next/server';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@/db';
import { postMetrics, publishedPosts } from '@/db/schema';
import { handler, ok, serverError } from '@/lib/api';
import { requireSecret } from '@/lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Metrics poller.
 *
 * Reads upvotes and comment counts for our published posts and writes a
 * snapshot. Runs every 15 minutes; Reddit rate limits are respected because we
 * only poll posts published in the last 30 days.
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const guard = requireSecret(
      request.headers.get('x-cron-secret') ?? request.nextUrl.searchParams.get('secret'),
      process.env.CRON_SECRET,
      'CRON_SECRET',
    );
    if (!guard.ok) return serverError(guard.error);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const posts = await db
      .select()
      .from(publishedPosts)
      .where(and(gt(publishedPosts.postedAt, since), eq(publishedPosts.status, 'live')))
      .limit(100);

    if (posts.length === 0) return ok({ updated: 0 });

    const fetcher = process.env.UPVOTE_METRICS_URL;
    if (!fetcher) {
      return ok({
        updated: 0,
        candidates: posts.length,
        warning: 'Set UPVOTE_METRICS_URL to the worker that holds the Reddit token.',
      });
    }

    let updated = 0;
    for (const post of posts) {
      try {
        const response = await fetch(`${fetcher}?redditId=${encodeURIComponent(post.redditId)}`, {
          headers: { authorization: `Bearer ${process.env.UPVOTE_WORKER_TOKEN ?? ''}` },
        });
        if (!response.ok) continue;
        const metrics = (await response.json()) as {
          upvotes: number;
          downvotes: number;
          comments: number;
          score: number;
          upvoteRatio: number;
          impressions?: number;
        };

        await db
          .insert(postMetrics)
          .values({
            id: `pm_${post.id}_${Date.now()}`,
            postId: post.id,
            upvotes: metrics.upvotes,
            downvotes: metrics.downvotes,
            comments: metrics.comments,
            score: metrics.score,
            upvoteRatio: metrics.upvoteRatio,
            impressions: metrics.impressions ?? 0,
          })
          .onConflictDoNothing();

        // A removal starts the cooldown, so reflect it immediately.
        if (metrics.score === 0 && metrics.comments === 0 && metrics.upvotes === 0) {
          await db.update(publishedPosts).set({ status: 'removed' }).where(eq(publishedPosts.id, post.id));
        }
        updated++;
      } catch {
        // One failed poll must not stop the run.
      }
    }

    return ok({ updated, candidates: posts.length });
  });
}