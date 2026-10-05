import { NextRequest } from 'next/server';
import {
  buildCrossPost,
  createDevToClient,
  createHashnodeClient,
  crossPostToAll,
  isValidSubredditName,
  type CrossPostResult,
  type CrossPostTarget,
} from '@upvote/core';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { drafts } from '@/db/schema';
import { badRequest, handler, ok, rateLimit, serverError } from '@/lib/api';
import { requireApiUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cross-post an approved draft to dev.to and/or Hashnode.
 *
 * Never automatic: a founder approves each Reddit post, and each cross-post is
 * its own call. Both platforms are rate-limited here so a loop cannot spam a
 * community that would then hold it against the founder.
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const user = await requireApiUser();
    if (!rateLimit(`crosspost:${user.id}`, 10, 60 * 60_000)) {
      return badRequest('Cross-posting limit reached for this hour.');
    }

    const body = (await request.json().catch(() => ({}))) as {
      draftId?: string;
      platforms?: Array<'devto' | 'hashnode'>;
    };
    const draftId = body.draftId;
    if (!draftId) return badRequest('draftId is required.');

    const [draft] = await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
      .limit(1);
    if (!draft) return badRequest('Draft not found.');
    if (draft.status === 'rejected') return badRequest('That draft was discarded.');
    if (draft.primarySubreddit && !isValidSubredditName(draft.primarySubreddit)) {
      return badRequest('Draft has an invalid subreddit name.');
    }

    const requested = body.platforms?.length ? body.platforms : (['devto', 'hashnode'] as const);
    const targets: Array<{
      platform: 'devto' | 'hashnode';
      client: { create: (t: CrossPostTarget) => Promise<CrossPostResult> };
    }> = [];

    if (requested.includes('devto')) {
      const apiKey = process.env.DEVTO_API_KEY;
      if (!apiKey) return badRequest('dev.to is not configured (DEVTO_API_KEY missing).');
      targets.push({ platform: 'devto', client: createDevToClient({ apiKey }) as never });
    }

    if (requested.includes('hashnode')) {
      const token = process.env.HASHNODE_ACCESS_TOKEN;
      if (!token) return badRequest('Hashnode is not configured (HASHNODE_ACCESS_TOKEN missing).');
      targets.push({
        platform: 'hashnode',
        client: createHashnodeClient({
          token,
          ...(process.env.HASHNODE_PUBLICATION_ID ? { publicationId: process.env.HASHNODE_PUBLICATION_ID } : {}),
        }) as never,
      });
    }

    if (targets.length === 0) return badRequest('No supported platform requested.');

    const results = await crossPostToAll(
      {
        title: draft.title,
        body: draft.body,
        firstComment: draft.firstComment,
        subreddit: draft.primarySubreddit,
        permalink: draft.permalink,
      },
      targets,
    );

    const ok_ = results.filter((r) => r.ok);
    return ok({ results, published: ok_.length, requested: requested.length });
  });
}

/** Preview what would be sent, without sending it. */
export async function GET(request: NextRequest) {
  return handler(async () => {
    const user = await requireApiUser();
    const draftId = request.nextUrl.searchParams.get('draftId');
    if (!draftId) return badRequest('draftId is required.');
    const [draft] = await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
      .limit(1);
    if (!draft) return badRequest('Draft not found.');
    return ok({
      devto: buildCrossPost({ ...draft, subreddit: draft.primarySubreddit, permalink: draft.permalink }, 'devto'),
      hashnode: buildCrossPost({ ...draft, subreddit: draft.primarySubreddit, permalink: draft.permalink }, 'hashnode'),
    });
  });
}

export { serverError };