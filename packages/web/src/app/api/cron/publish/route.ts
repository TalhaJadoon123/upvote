import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { failItem, type ScheduledItem } from '@upvote/scheduler';
import { safeErrorMessage } from '@upvote/core';
import { db } from '@/db';
import { drafts, publishedPosts } from '@/db/schema';
import { handler, ok, serverError } from '@/lib/api';
import { defaultGuardrails } from '@/lib/guardrails';
import { getTransport } from '@/lib/publish-transport';
import { requireSecret } from '@/lib/secrets';

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
    const guard = requireSecret(
      request.headers.get('x-cron-secret') ?? request.nextUrl.searchParams.get('secret'),
      process.env.CRON_SECRET,
      'CRON_SECRET',
    );
    if (!guard.ok) return serverError(guard.error);

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
        // A post without an id or permalink cannot be tracked later, so refuse
        // to record it rather than writing a row we can never reconcile.
        if (!result.redditId || !result.permalink) {
          throw new Error('Publisher returned no reddit id or permalink.');
        }

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
          config: defaultGuardrails(),
        };
        const failure = failItem(state, draft.id, safeErrorMessage(error), { maxAttempts: 3 });
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
