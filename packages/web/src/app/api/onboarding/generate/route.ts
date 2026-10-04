import { NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import {
  generateDraftSet,
  momentFromText,
  type StyleVector,
  type VoiceProfile,
} from '@upvote/core';
import { balanceSamples, deduplicateSamples, trainVoiceProfile, samplesFromRedditListing } from '@upvote/voice';
import { db } from '@/db';
import { connections, drafts, shippingMoments, users, voiceProfiles, voiceSamples, type VoiceProfileRow } from '@/db/schema';
import { decryptTokens } from '@/lib/crypto';
import { badRequest, handler, ok, rateLimit } from '@/lib/api';
import { requireApiUser } from '@/lib/auth';
import { RedditClient } from '@upvote/reddit';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The 60-second onboarding generation.
 *
 * Takes whatever the founder gave us — Reddit history, pasted samples, or both —
 * trains (or reuses) a profile, then returns finished drafts. This is the moment
 * the product has to prove itself, so it never returns a partial result: if the
 * voice gate rejects every draft we say so rather than showing filler.
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const user = await requireApiUser();
    if (!rateLimit(`onboard:${user.id}`, 10, 60_000)) {
      return badRequest('Slow down a moment, then try again.');
    }

    const body = (await request.json().catch(() => ({}))) as { moment?: string; samples?: string };
    const momentText = (body.moment ?? '').trim();
    if (momentText.length < 20) return badRequest('Describe what you shipped in a sentence or two.');

    /* ---- 1. gather samples ---- */
    const samples: VoiceSample[] = [];

    const [existingProfile] = await db
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.userId, user.id))
      .orderBy(desc(voiceProfiles.version))
      .limit(1);

    if (!existingProfile) {
      const pasted = (body.samples ?? '')
        .split(/\n\s*\n/)
        .map((text, i) => ({ id: `paste_${i}`, source: 'reddit_post' as const, text: text.trim(), score: 0 }))
        .filter((s) => s.text.length >= 40);
      samples.push(...pasted);

      // Reddit history is the best source when the account is connected.
      const [redditConnection] = await db
        .select()
        .from(connections)
        .where(and(eq(connections.userId, user.id), eq(connections.provider, 'reddit')))
        .limit(1);

      if (redditConnection) {
        try {
          const access = decryptTokens<{ accessToken: string }>(redditConnection.accessTokenEncrypted);
          const refresh = redditConnection.refreshTokenEncrypted
            ? decryptTokens<{ refreshToken: string }>(redditConnection.refreshTokenEncrypted)
            : null;
          const client = new RedditClient({
            clientId: process.env.REDDIT_CLIENT_ID ?? '',
            clientSecret: process.env.REDDIT_CLIENT_SECRET ?? '',
            tokens: {
              accessToken: access.accessToken,
              ...(refresh?.refreshToken ? { refreshToken: refresh.refreshToken } : {}),
              obtainedAt: redditConnection.updatedAt.toISOString(),
            },
          });
          const listing = await client.getMyActivity({ limit: 100 });
          samples.push(...samplesFromRedditListing(listing as never));
        } catch {
          // A missing or expired Reddit token must not block onboarding.
        }
      }
    }

    let profile: VoiceProfile | null = existingProfile ? rowToProfile(existingProfile) : null;

    if (samples.length > 0 && balanceSamples(deduplicateSamples(samples)).length >= 3) {
      const trained = trainVoiceProfile(balanceSamples(deduplicateSamples(samples)), {
        userId: user.id,
        version: (existingProfile?.version ?? 0) + 1,
      });
      const id = `vp_${user.id}_v${trained.profile.version}`;
      await db.insert(voiceProfiles).values({
        id,
        userId: user.id,
        version: trained.profile.version,
        sampleCount: trained.profile.sampleCount,
        qualityScore: trained.quality.score,
        readyForProduction: trained.quality.readyForProduction,
        vector: trained.profile.vector as unknown as Record<string, number>,
        variance: trained.profile.variance,
        signaturePhrases: trained.profile.signaturePhrases,
        favoriteWords: trained.profile.favoriteWords,
        bannedWords: trained.profile.bannedWords,
        embedding: trained.profile.embedding,
        settings: trained.profile.settings as unknown as Record<string, unknown>,
        trainedAt: new Date(trained.profile.trainedAt),
      });

      for (const sample of balanceSamples(deduplicateSamples(samples)).slice(0, 500)) {
        await db
          .insert(voiceSamples)
          .values({
            id: createHash('sha1').update(`${user.id}:${sample.id}`).digest('hex').slice(0, 32),
            userId: user.id,
            profileId: id,
            source: sample.source,
            text: sample.text,
            score: sample.score ?? 0,
            externalId: sample.id,
          })
          .onConflictDoNothing();
      }

      profile = {
        ...(trained.profile as VoiceProfile),
        id,
      };
    }

    if (!profile) {
      return badRequest(
        'We need a little of your writing before we can draft in your voice. Connect Reddit or paste a few posts.',
      );
    }

    /* ---- 2. generate ---- */
    const moment = momentFromText(momentText, []);
    await db
      .insert(shippingMoments)
      .values({
        id: moment.id,
        userId: user.id,
        kind: 'manual',
        title: moment.title,
        body: moment.body,
        whatChanged: moment.whatChanged,
        lesson: moment.lesson,
        tags: moment.tags,
        source: moment.source,
      })
      .onConflictDoNothing();

    const set = await generateDraftSet(moment, {
      userId: user.id,
      profile: profile as unknown as VoiceProfile,
      minAuthenticity: 85,
      maxAttempts: 3,
      model: null,
    });

    for (const draft of set.drafts) {
      await db
        .insert(drafts)
        .values({
          id: draft.id,
          userId: user.id,
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
    }

    await db.update(users).set({ onboardedAt: new Date() }).where(eq(users.id, user.id));

    return ok({
      draftsCreated: set.drafts.length,
      rejected: set.rejected,
      profileVersion: profile.version,
      sampleCount: profile.sampleCount,
    });
  });
}

type VoiceSample = {
  id: string;
  source: 'reddit_post' | 'reddit_comment' | 'tweet' | 'blog' | 'readme' | 'commit';
  text: string;
  score?: number;
};

/** Map a stored profile row back into the core VoiceProfile shape. */
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
      profanityAllowed: Boolean((row.settings as Record<string, unknown>).profanityAllowed ?? false),
      ctaStyle: 'soft',
      bannedPhrases: [],
    },
    trainedAt: row.trainedAt.toISOString(),
  };
}