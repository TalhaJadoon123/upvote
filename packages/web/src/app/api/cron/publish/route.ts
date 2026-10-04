import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { claimItem, completeItem, failItem, type ScheduledItem } from '@upvote/scheduler';
import { db } from '@/db';
import { drafts, publishedPosts, users } from '@/db/schema';
import { handler, ok, serverError } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cron entry point: publish everything that is due.
 *
 * Secured by a shared secret rather than a user session, because cron is a
 * machine. Called every minute by the host scheduler (or BullMQ in a
 * self-hosted deployment).
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    const provided = request.headers.get('x-cron-secret') ?? request.nextUrl.searchParams.get('secret');
    if (!secret || provided !== secret) return serverError('Unauthorized cron call.');

    const now = new Date();
    const due = await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.status, 'scheduled')))
      .orderBy(drafts.scheduledFor)
      .limit(25);

    const publishable = due.filter(
      (draft) => draft.scheduledFor && draft.scheduledFor.getTime() <= now.getTime() && draft.primarySubreddit,
    );
    if (publishable.length === 0) return ok({ published: 0, skipped: due.length });

    // The posting transport is injected by the deployment via publishHandler().
    // Without it we report honestly rather than pretending a post went out.
    const transport = getTransport();
    if (!transport) {
      return ok({
        published: 0,
        due: publishable.length,
        warning:
          'No Reddit transport configured on the server. Set UPVOTE_REDDIT_PUBLISH_URL or use the CLI to publish.',
      });
    }

    let published = 0;
    for (const draft of publishable) {
      try {
        const result = await transport({
          draftId: draft.id,
          subreddit: draft.primarySubreddit!,
          title: draft.title,
          body: draft.body,
          flair: draft.flair,
        });
        if (!result.ok) throw new Error(result.error);

        await db
          .insert(publishedPosts)
          .values({
            id: `post_${draft.id.slice(-8)}`,
            userId: draft.userId,
            draftId: draft.id,
            subreddit: draft.primarySubreddit!,
            redditId: result.redditId,
            permalink: result.permalink,
            title: draft.title,
            style: draft.style,
            voiceScore: draft.authenticityScore,
            trackedUrl: result.trackedUrl ?? null,
          })
          .onConflictDoNothing();

        await db
          .update(drafts)
          .set({ status: 'posted', postedAt: new Date(), redditId: result.redditId, permalink: result.permalink })
          .where(eq(drafts.id, draft.id));
        published++;
      } catch (error) {
        // Reuse the scheduler's backoff so a Reddit outage does not turn into a
        // stampede of retries.
        const state = {
          items: [{ ...itemFrom(draft), status: 'scheduled' } as ScheduledItem],
          history: [],
          config: { minAuthenticityScore: 85, requireManualApproval: true, maxPostsPerDay: 3, maxPostsPerSubredditPerWeek: 1, blocklist: [], avoidCategories: [], maxCommentsPerDay: 30, cooldownHoursAfterRemoval: 72, requirePriorEngagement: true, minAccountAgeDays: 0 },
        };
        const failure = failItem(state, draft.id, (error as Error).message, { maxAttempts: 3 });
        await db
          .update(drafts)
          .set({
            status: failure.exhausted ? 'failed' : 'scheduled',
            scheduledFor: failure.retryAt ? new Date(failure.retryAt) : draft.scheduledFor,
            updatedAt: new Date(),
          })
          .where(eq(drafts.id, draft.id));
      }
    }

    void users;
    void inArray;
    void claimItem;
    void completeItem;
    return ok({ published, due: publishable.length });
  });
}

function itemFrom(draft: typeof drafts.$inferSelect): ScheduledItem {
  return {
    draftId: draft.id,
    userId: draft.userId,
    subreddit: draft.primarySubreddit ?? 'unknown',
    runAt: (draft.scheduledFor ?? new Date()).toISOString(),
    reason: 'cron',
    attempts: 0,
    status: 'scheduled',
  };
}

export interface PublishResult {
  ok: boolean;
  redditId?: string;
  permalink?: string;
  trackedUrl?: string | null;
  error?: string;
}

type Transport = (input: {
  draftId: string;
  subreddit: string;
  title: string;
  body: string;
  flair: string;
}) => Promise<PublishResult>;

let transport: Transport | null = null;

/**
 * Register the function that actually talks to Reddit.
 *
 * The web app deliberately does not hold Reddit tokens: publishing happens with
 * the founder's token, which lives with the CLI or with the publish worker. The
 * dashboard calls out to that worker over HTTP.
 */
export function registerTransport(fn: Transport): void {
  transport = fn;
}

function getTransport(): Transport | null {
  if (transport) return transport;

  const url = process.env.UPVOTE_REDDIT_PUBLISH_URL;
  const token = process.env.UPVOTE_WORKER_TOKEN;
  if (!url || !token) return null;

  return async (input) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
    if (!response.ok) return { ok: false, error: `Worker returned ${response.status}` };
    return (await response.json()) as PublishResult;
  };
}