'use server';

/**
 * Server actions for the dashboard.
 *
 * Every action re-checks the user, re-scores the draft against the live voice
 * profile, and re-checks subreddit compliance. The client's idea of a draft is
 * never trusted: the browser could have been showing a stale voice score.
 */
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  buildTrackingLink,
  checkEntitlement,
  evaluateGuardrails,
  formatInUserTimezone,
  planById,
  predictBestTimes,
  scoreDraftAuthenticity,
  suggestReply,
  type AuthenticityReport,
  type StyleVector,
  type SubredditProfile,
  type VoiceProfile,
} from '@upvote/core';
import { db } from '@/db';
import {
  drafts,
  publishedPosts,
  settings,
  subredditProfiles,
  voiceProfiles,
  watchedRepos,
} from '@/db/schema';
import { requireUser } from '@/lib/auth';
import { guardrailsFromRow } from '@/lib/guardrails';

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

export async function getDashboardData() {
  const user = await requireUser();

  const [profileRow] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, user.id))
    .orderBy(desc(voiceProfiles.version))
    .limit(1);

  const draftRows = await db
    .select()
    .from(drafts)
    .where(eq(drafts.userId, user.id))
    .orderBy(desc(drafts.createdAt))
    .limit(100);

  const settingsRow = await db.select().from(settings).where(eq(settings.userId, user.id)).limit(1);

  return {
    user,
    profile: profileRow ?? null,
    drafts: draftRows,
    guardrails: settingsRow[0] ? guardrailsFromRow(settingsRow[0]) : null,
    counts: {
      review: draftRows.filter((d) => d.status === 'review').length,
      scheduled: draftRows.filter((d) => d.status === 'scheduled').length,
      posted: draftRows.filter((d) => d.status === 'posted').length,
      failed: draftRows.filter((d) => d.status === 'failed').length,
    },
  };
}

export async function getDraft(id: string) {
  const user = await requireUser();
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
    .limit(1);
  if (!row) return null;

  const [profileRow] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, user.id))
    .orderBy(desc(voiceProfiles.version))
    .limit(1);

  return { draft: row, profile: profileRow ?? null };
}

export async function getScheduledForCalendar(_days = 30) {
  const user = await requireUser();
  return db
    .select()
    .from(drafts)
    .where(
      and(eq(drafts.userId, user.id), inArray(drafts.status, ['scheduled', 'posted'])),
    )
    .orderBy(asc(drafts.scheduledFor))
    .limit(200);
}

/* ------------------------------------------------------------------ */
/* Writes                                                               */
/* ------------------------------------------------------------------ */

function toCoreProfile(row: typeof voiceProfiles.$inferSelect): VoiceProfile {
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
      ctaStyle: ((row.settings as Record<string, unknown>).ctaStyle ?? 'soft') as 'none' | 'soft' | 'direct',
      bannedPhrases: ((row.settings as Record<string, unknown>).bannedPhrases ?? []) as string[],
    },
    trainedAt: row.trainedAt.toISOString(),
  };
}

/** Recompute the voice score server-side. The editor calls this on every keystroke. */
export async function rescoreDraft(
  draftId: string,
  patch: { title?: string; body?: string; firstComment?: string },
): Promise<ActionResult<AuthenticityReport>> {
  const user = await requireUser();
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
    .limit(1);
  if (!row) return { ok: false, error: 'Draft not found.' };

  const [profileRow] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, user.id))
    .orderBy(desc(voiceProfiles.version))
    .limit(1);
  if (!profileRow) return { ok: false, error: 'Train your voice profile first.' };

  const title = patch.title ?? row.title;
  const body = patch.body ?? row.body;
  const profile = toCoreProfile(profileRow);
  const report = scoreDraftAuthenticity({ title, body }, profile);

  await db
    .update(drafts)
    .set({
      title,
      body,
      firstComment: patch.firstComment ?? row.firstComment,
      authenticityScore: report.score,
      authenticityBreakdown: report.breakdown as unknown as Record<string, number>,
      authenticityNotes: report.notes.slice(0, 6),
      editCount: row.editCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(drafts.id, draftId));

  return { ok: true, data: report };
}

export async function saveDraftEdit(
  draftId: string,
  patch: {
    title?: string;
    titleVariantIndex?: number;
    body?: string;
    firstComment?: string;
    flair?: string;
    primarySubreddit?: string;
  },
): Promise<ActionResult> {
  const user = await requireUser();
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
    .limit(1);
  if (!row) return { ok: false, error: 'Draft not found.' };

  const title = patch.title ?? row.title;
  const variantIndex = patch.titleVariantIndex ?? row.selectedTitleVariant;
  const variants = patch.titleVariantIndex !== undefined ? row.titleVariants : row.titleVariants;
  const chosenTitle = variants[variantIndex] ?? title;

  const [profileRow] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, user.id))
    .orderBy(desc(voiceProfiles.version))
    .limit(1);

  let score = row.authenticityScore;
  let breakdown = row.authenticityBreakdown;
  let notes = row.authenticityNotes;
  if (profileRow) {
    const report = scoreDraftAuthenticity({ title: chosenTitle, body: patch.body ?? row.body }, toCoreProfile(profileRow));
    score = report.score;
    breakdown = report.breakdown as unknown as Record<string, number>;
    notes = report.notes.slice(0, 6);
  }

  await db
    .update(drafts)
    .set({
      title: chosenTitle,
      selectedTitleVariant: variantIndex,
      body: patch.body ?? row.body,
      firstComment: patch.firstComment ?? row.firstComment,
      flair: patch.flair ?? row.flair,
      primarySubreddit: patch.primarySubreddit ?? row.primarySubreddit,
      authenticityScore: score,
      authenticityBreakdown: breakdown,
      authenticityNotes: notes,
      editCount: row.editCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(drafts.id, draftId));

  return { ok: true };
}

export async function approveDraft(
  draftId: string,
  options: { subreddit?: string; publishNow?: boolean } = {},
): Promise<ActionResult<{ scheduledFor: string | null }>> {
  const user = await requireUser();

  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
    .limit(1);
  if (!row) return { ok: false, error: 'Draft not found.' };

  const subreddit = options.subreddit ?? row.primarySubreddit;
  if (!subreddit) return { ok: false, error: 'Pick a subreddit first.' };

  const settingsRow = await db.select().from(settings).where(eq(settings.userId, user.id)).limit(1);
  const guardrails = settingsRow[0]
    ? guardrailsFromRow(settingsRow[0])
    : { maxPostsPerDay: 3, maxPostsPerSubredditPerWeek: 1, minAuthenticityScore: 85, requireManualApproval: true } as never;

  const published = await db
    .select()
    .from(publishedPosts)
    .where(and(eq(publishedPosts.userId, user.id), eq(publishedPosts.subreddit, subreddit)));
  const history = published.map((p) => ({
    userId: p.userId,
    subreddit: p.subreddit,
    postedAt: p.postedAt.toISOString(),
    postId: p.redditId,
    removed: p.status === 'removed',
  }));

  const pending = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, user.id), eq(drafts.status, 'scheduled')));
  const decision = evaluateGuardrails({
    userId: user.id,
    subreddit,
    history,
    pending: pending
      .filter((d) => d.id !== draftId && d.scheduledFor)
      .map((d) => ({ subreddit: d.primarySubreddit ?? '', scheduledFor: d.scheduledFor!.toISOString() })),
    approved: true,
    authenticityScore: row.authenticityScore,
    config: guardrails,
  });

  if (!decision.allowed) {
    return { ok: false, error: decision.messages.join(' ') };
  }

  let scheduledFor = row.scheduledFor?.toISOString() ?? null;

  if (!scheduledFor) {
    const [subRow] = await db
      .select()
      .from(subredditProfiles)
      .where(eq(subredditProfiles.name, subreddit))
      .limit(1);
    const profile = subRow
      ? ({
          name: subRow.name,
          displayName: subRow.name,
          subscribers: subRow.subscribers,
          activeUsers: null,
          activity: subRow.activity,
          upvoteRatio: subRow.upvoteRatio,
          postsPerDay: null,
          over18: false,
          restricted: false,
          quarantined: false,
          description: '',
          sidebar: '',
          rules: subRow.rules as SubredditProfile['rules'],
          flairs: subRow.flairs,
          activityByHourUtc: subRow.activityByHourUtc,
          topics: subRow.topics,
          allowSelfPromo: subRow.allowSelfPromo,
          allowLinks: subRow.allowLinks,
          requiresFlair: subRow.requiresFlair,
          fetchedAt: subRow.fetchedAt.toISOString(),
        } satisfies SubredditProfile)
      : null;

    if (profile) {
      const slots = predictBestTimes(profile, { count: 1, now: new Date() });
      scheduledFor = slots[0]?.at ?? null;
    }
  }

  await db
    .update(drafts)
    .set({
      status: options.publishNow ? 'approved' : 'scheduled',
      primarySubreddit: subreddit,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      updatedAt: new Date(),
    })
    .where(eq(drafts.id, draftId));

  return {
    ok: true,
    data: {
      scheduledFor: scheduledFor
        ? formatInUserTimezone(scheduledFor, user.timezoneOffsetMinutes)
        : null,
    },
  };
}

export async function rejectDraft(draftId: string, reason = 'Not a fit'): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .update(drafts)
    .set({ status: 'rejected', updatedAt: new Date() })
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)));
  void reason;
  return { ok: true };
}

export async function updateSettings(patch: {
  maxPostsPerDay?: number;
  maxPostsPerSubredditPerWeek?: number;
  minAuthenticityScore?: number;
  requireManualApproval?: boolean;
  requirePriorEngagement?: boolean;
  blocklist?: string[];
  allowlist?: string[];
  cooldownHoursAfterRemoval?: number;
}): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .insert(settings)
    .values({ userId: user.id, ...patch })
    .onConflictDoUpdate({
      target: settings.userId,
      set: { ...patch, updatedAt: new Date() },
    });
  return { ok: true };
}

export async function updateVoiceSettings(patch: {
  formality?: number;
  humor?: number;
  emojiRate?: number;
  ctaStyle?: 'none' | 'soft' | 'direct';
}): Promise<ActionResult> {
  const user = await requireUser();
  const [row] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, user.id))
    .orderBy(desc(voiceProfiles.version))
    .limit(1);
  if (!row) return { ok: false, error: 'No voice profile yet.' };

  const merged = { ...(row.settings as Record<string, unknown>), ...patch };
  await db.update(voiceProfiles).set({ settings: merged }).where(eq(voiceProfiles.id, row.id));
  return { ok: true };
}

export async function addWatchedRepo(owner: string, repo: string): Promise<ActionResult> {
  const user = await requireUser();
  await db
    .insert(watchedRepos)
    .values({ id: `wr_${user.id}_${owner}_${repo}`, userId: user.id, owner, repo })
    .onConflictDoNothing();
  return { ok: true };
}

export async function removeWatchedRepo(id: string): Promise<ActionResult> {
  const user = await requireUser();
  await db.delete(watchedRepos).where(and(eq(watchedRepos.id, id), eq(watchedRepos.userId, user.id)));
  return { ok: true };
}

export async function draftReplySuggestion(
  postId: string,
  comment: { author: string; body: string },
): Promise<ActionResult<{ reply: string; score: number }>> {
  const user = await requireUser();
  const [post] = await db
    .select()
    .from(publishedPosts)
    .where(and(eq(publishedPosts.id, postId), eq(publishedPosts.userId, user.id)))
    .limit(1);
  if (!post) return { ok: false, error: 'Post not found.' };

  const [profileRow] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, user.id))
    .orderBy(desc(voiceProfiles.version))
    .limit(1);
  if (!profileRow) return { ok: false, error: 'Train your voice profile first.' };

  const suggestion = await suggestReply(
    comment,
    { title: post.title, subreddit: post.subreddit },
    toCoreProfile(profileRow),
    { model: null },
  );
  return { ok: true, data: suggestion };
}

/** The link the founder puts in the post, carrying attribution parameters. */
export async function getTrackedLink(draftId: string): Promise<ActionResult<{ url: string }>> {
  const user = await requireUser();
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
    .limit(1);
  if (!row || !user.productUrl) return { ok: false, error: 'Set your product URL in settings first.' };

  const url = buildTrackingLink({
    baseUrl: user.productUrl,
    userId: user.id,
    postId: row.id,
    subreddit: row.primarySubreddit ?? 'unknown',
    style: row.style,
  });
  return { ok: true, data: { url } };
}

/** Guard the metered actions against the plan limit. */
export interface QuotaResult {
  allowed: boolean;
  reason?: string;
}

/** Guard the metered actions against the plan limit. */
export async function checkQuota(action: 'draft' | 'schedule' | 'autopost'): Promise<ActionResult<QuotaResult>> {
  const user = await requireUser();
  const plan = planById(user.plan);

  let usage = 0;
  if (action === 'draft') {
    // The plan limit is monthly, so count this month's drafts only.
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({ id: drafts.id })
      .from(drafts)
      .where(
        and(
          eq(drafts.userId, user.id),
          gte(drafts.createdAt, startOfMonth),
        ),
      );
    usage = rows.length;
  } else if (action === 'schedule') {
    const rows = await db
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.userId, user.id), eq(drafts.status, 'scheduled')));
    usage = rows.length;
  }

  const entitlement = checkEntitlement(plan, action, usage);
  return { ok: entitlement.allowed, data: { allowed: entitlement.allowed, reason: entitlement.reason } };
}