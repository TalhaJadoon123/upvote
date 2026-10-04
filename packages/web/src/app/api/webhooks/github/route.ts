import { NextRequest } from 'next/server';
import { momentFromWebhook, verifyWebhookSignature, mapEvent } from '@upvote/gh';
import { generateDraftSet, type StyleVector, type VoiceProfile } from '@upvote/core';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { drafts, shippingMoments, voiceProfiles, watchedRepos, type VoiceProfileRow } from '@/db/schema';
import { handler, ok, rateLimit, unauthorized } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub webhook receiver.
 *
 * Order matters: verify the signature before reading anything else, then
 * filter, then generate. A webhook storm of `ping` events must cost us nothing
 * more than a signature check.
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return unauthorized('Webhook secret is not configured.');

    const raw = await request.text();
    if (!verifyWebhookSignature(raw, request.headers.get('x-hub-signature-256'), secret)) {
      return unauthorized('Invalid webhook signature.');
    }

    // A single repo can push many times a minute; protect the generator.
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!rateLimit(`gh:${ip}`, 120, 60_000)) {
      return new Response('rate limited', { status: 429 });
    }

    const event = mapEvent(request.headers.get('x-github-event'));
    const payload = JSON.parse(raw) as Record<string, unknown>;

    const repo = (payload.repository as { full_name?: string } | undefined)?.full_name ?? '';
    const [owner, name] = repo.split('/');
    if (!owner || !name) return ok({ skipped: 'no repository in payload' });

    const watched = await db
      .select()
      .from(watchedRepos)
      .where(and(eq(watchedRepos.owner, owner), eq(watchedRepos.repo, name), eq(watchedRepos.enabled, true)));

    // Fan out to every user watching this repo.
    let draftsCreated = 0;
    for (const repo_owner of watched) {
      const users = await db
        .select({ userId: watchedRepos.userId })
        .from(watchedRepos)
        .where(eq(watchedRepos.id, repo_owner.id));
      for (const { userId } of users) {
        const envelope = momentFromWebhook(event, payload, {
          shippableLabels: repo_owner.shippableLabels.length > 0 ? repo_owner.shippableLabels : undefined,
        });
        if (!envelope.moment) continue;

        const [profileRow] = await db
          .select()
          .from(voiceProfiles)
          .where(eq(voiceProfiles.userId, userId))
          .orderBy((t) => t.version)
          .limit(1);
        if (!profileRow) continue;

        const moment = envelope.moment;
        await db
          .insert(shippingMoments)
          .values({
            id: moment.id,
            userId,
            kind: moment.kind,
            title: moment.title,
            body: moment.body,
            whatChanged: moment.whatChanged,
            lesson: moment.lesson,
            tags: moment.tags,
            source: moment.source as Record<string, unknown>,
            repoOwner: owner,
            repoName: name,
          })
          .onConflictDoNothing();

        const profile = rowToProfile(profileRow);
        const set = await generateDraftSet(moment, {
          userId,
          profile,
          minAuthenticity: 85,
          maxAttempts: 3,
          model: null,
        });

        for (const draft of set.drafts) {
          await db
            .insert(drafts)
            .values({
              id: draft.id,
              userId,
              momentId: moment.id,
              style: draft.style,
              status: 'review',
              title: draft.title,
              titleVariants: draft.titleVariants,
              selectedTitleVariant: draft.selectedTitleVariant,
              body: draft.body,
              firstComment: draft.firstComment,
              flair: draft.flair,
              primarySubreddit: draft.primarySubreddit,
              suggestedSubreddits: draft.suggestedSubreddits,
              authenticityScore: draft.authenticityScore,
              authenticityBreakdown: draft.authenticity as unknown as Record<string, number>,
              authenticityNotes: draft.authenticityNotes,
              generator: draft.generator,
            })
            .onConflictDoNothing();
          draftsCreated++;
        }
      }
    }

    return ok({ event, draftsCreated });
  });
}

function rowToProfile(row: VoiceProfileRow): VoiceProfile {
  return {
    id: row.id,
    userId: row.userId,
    version: row.version,
    sampleCount: row.sampleCount,
    vector: row.vector as unknown as StyleVector,
    variance: row.variance,
    signaturePhrases: row.signaturePhrases,
    favoriteWords: row.favoriteWords,
    bannedWords: row.bannedWords,
    emojiFavorites: [],
    openers: [],
    closers: [],
    embedding: row.embedding,
    settings: {
      formality: Number((row.settings as Record<string, unknown>).formality ?? 0.5),
      humor: Number((row.settings as Record<string, unknown>).humor ?? 0.3),
      emojiRate: Number((row.settings as Record<string, unknown>).emojiRate ?? 1),
      profanityAllowed: false,
      ctaStyle: 'soft',
      bannedPhrases: [],
    },
    trainedAt: row.trainedAt.toISOString(),
  };
}

/** GitHub pings this on webhook creation. */
export async function GET() {
  return ok({ ok: true, service: 'upvote-webhook' });
}