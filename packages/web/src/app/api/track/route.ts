import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { parseAttribution } from '@upvote/core';
import { db } from '@/db';
import { attributionEvents, publishedPosts } from '@/db/schema';
import { handler, notFound, ok, rateLimit } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Click + signup tracking.
 *
 * The `upv` parameter on every post link resolves to the post that produced it.
 * This endpoint is the join point between a Reddit upvote and a paying customer,
 * so it must never block the founder's traffic: it fires, records, and returns.
 */
export async function GET(request: NextRequest) {
  return handler(async () => {
    const url = new URL(request.url);
    const attribution = parseAttribution(url.searchParams);

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (attribution && rateLimit(`click:${ip}:${attribution.upv}`, 5, 10_000)) {
      const [post] = await db
        .select({ id: publishedPosts.id, userId: publishedPosts.userId })
        .from(publishedPosts)
        .where(eq(publishedPosts.id, attribution.postId))
        .limit(1);

      if (post) {
        await db
          .insert(attributionEvents)
          .values({
            id: `attr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            postId: post.id,
            userId: post.userId,
            kind: 'click',
            clickId: attribution.upv,
            referer: request.headers.get('referer') ?? undefined,
          })
          .onConflictDoNothing();
      }
    }

    // Only ever redirect to a destination we can prove is ours.
    // `to=https://evil.example` on our own domain would be a phishing primitive,
    // and this endpoint is linked from a public Reddit post.
    const destination = url.searchParams.get('to') ?? '/';
    const next = safeRedirect(url, destination);

    // Carry the campaign parameters through so the product's own analytics still
    // see them, minus the click id which has done its job.
    for (const key of [...url.searchParams.keys()]) {
      if (key === 'to' || key === 'upv' || key === 'utm_term') continue;
      next.searchParams.set(key, url.searchParams.get(key) ?? '');
    }
    return NextResponse.redirect(next);
  });
}

/**
 * Build a redirect target that cannot leave our infrastructure.
 *
 * Absolute URLs are only honoured when their hostname matches APP_URL or an
 * explicitly configured product host. Everything else degrades to the app root.
 */
function safeRedirect(requestUrl: URL, destination: string): URL {
  const self = new URL('/', requestUrl.origin);

  let candidate: URL;
  try {
    // A relative destination is resolved against our own origin.
    candidate = new URL(destination, requestUrl.origin);
  } catch {
    return self;
  }
  if (candidate.origin !== requestUrl.origin) return self;

  const allowed = new Set<string>([requestUrl.hostname]);
  const productHost = process.env.PRODUCT_ALLOWED_HOST;
  if (productHost) allowed.add(productHost.toLowerCase());
  if (!allowed.has(candidate.hostname.toLowerCase())) return self;

  return candidate;
}

/** Explicit signup beacon, fired from the app when a user signs up. */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!rateLimit(`signup:${ip}`, 20, 60_000)) return ok({ recorded: false });

    const body = (await request.json().catch(() => ({}))) as {
      clickId?: string;
      postId?: string;
      revenueCents?: number;
      userId?: string;
    };

    let postId = body.postId ?? null;
    if (!postId && body.clickId) {
      const [post] = await db
        .select({ id: publishedPosts.id })
        .from(publishedPosts)
        .where(eq(publishedPosts.trackedUrl, body.clickId))
        .limit(1);
      postId = post?.id ?? null;
    }
    if (!postId) return notFound('Unknown post reference.');

    const [post] = await db
      .select({ id: publishedPosts.id, userId: publishedPosts.userId })
      .from(publishedPosts)
      .where(and(eq(publishedPosts.id, postId)))
      .limit(1);
    if (!post) return notFound('Unknown post.');

    await db
      .insert(attributionEvents)
      .values({
        id: `attr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        postId: post.id,
        userId: post.userId,
        kind: 'signup',
        revenueCents: body.revenueCents ?? 0,
        clickId: body.clickId,
      })
      .onConflictDoNothing();

    return ok({ recorded: true });
  });
}