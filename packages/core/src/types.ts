/**
 * Domain model shared by every package.
 *
 * Pipeline shape:
 *   ShippingMoment  ──▶ DraftSet (5 styles) ──▶ Draft ──▶ Schedule ──▶ PublishedPost ──▶ Metrics
 *        ▲                 │
 *        └── VoiceProfile ─┴──▶ AuthenticityReport
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Shipping moments (the raw signal from GitHub or a manual entry)      */
/* ------------------------------------------------------------------ */

export const MomentKindSchema = z.enum([
  'release',
  'commit',
  'pr_merged',
  'issue_closed',
  'readme_change',
  'milestone',
  'manual',
]);
export type MomentKind = z.infer<typeof MomentKindSchema>;

export const ShippingMomentSchema = z.object({
  id: z.string().min(1),
  kind: MomentKindSchema,
  /** Primary source of truth. */
  title: z.string().min(1),
  /** Prose detail: commit body, release notes, PR description, founder notes. */
  body: z.string().default(''),
  /** Anything a human would actually say happened. */
  whatChanged: z.string().default(''),
  /** The hard-won insight — the reason anyone would read the post. */
  lesson: z.string().default(''),
  /** Technologies / topics, used for subreddit matching. */
  tags: z.array(z.string()).default([]),
  /** Where it happened: repo name, PR number, release tag. */
  source: z
    .object({
      repo: z.string().optional(),
      url: z.string().url().optional(),
      ref: z.string().optional(),
      author: z.string().optional(),
      stars: z.number().int().nonnegative().optional(),
      commitSha: z.string().optional(),
      commitCount: z.number().int().nonnegative().optional(),
    })
    .default({}),
  /** When the work actually happened (not when we noticed it). */
  occurredAt: z.string().datetime().optional(),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
});
export type ShippingMoment = z.infer<typeof ShippingMomentSchema>;

/* ------------------------------------------------------------------ */
/* Drafts                                                               */
/* ------------------------------------------------------------------ */

export const DraftStyleSchema = z.enum([
  'show_and_tell',
  'story',
  'question',
  'data',
  'comment_reply',
]);
export type DraftStyle = z.infer<typeof DraftStyleSchema>;

export const DraftStatusSchema = z.enum([
  'draft',
  'review',
  'approved',
  'scheduled',
  'posted',
  'failed',
  'rejected',
]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

export const SubredditSuggestionSchema = z.object({
  subreddit: z.string().regex(/^[A-Za-z0-9_]{2,32}$/),
  /** 0-100 composite fit. */
  fit: z.number().min(0).max(100),
  reasons: z.array(z.string()).default([]),
  /** Human-readable rule summary that the draft already satisfies. */
  compliance: z.array(z.string()).default([]),
  /** Rule violations that must be fixed before posting. */
  violations: z.array(z.string()).default([]),
  compliant: z.boolean(),
  subscribers: z.number().int().nonnegative().nullable().default(null),
  /** 0-100 — how lively this subreddit is right now. */
  activity: z.number().min(0).max(100).nullable().default(null),
  /** Best posting windows as UTC hours with a 0-1 score. */
  bestHoursUtc: z.array(z.number().min(0).max(23)).default([]),
});
export type SubredditSuggestion = z.infer<typeof SubredditSuggestionSchema>;

export const DraftSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  momentId: z.string(),
  style: DraftStyleSchema,
  status: DraftStatusSchema.default('draft'),
  title: z.string().min(1),
  titleVariants: z.array(z.string().min(1)).min(1).max(5),
  selectedTitleVariant: z.number().int().nonnegative().default(0),
  /** Reddit-native markdown body. */
  body: z.string().min(1),
  /** The OP follow-up that adds value and seeds the comment section. */
  firstComment: z.string().default(''),
  flair: z.string().default(''),
  flairId: z.string().nullable().default(null),
  linkUrl: z.string().url().nullable().default(null),
  suggestedSubreddits: z.array(SubredditSuggestionSchema).default([]),
  primarySubreddit: z.string().nullable().default(null),
  /** 0-100. Below `authenticityThreshold` the draft is regenerated, never posted. */
  authenticityScore: z.number().min(0).max(100).default(0),
  authenticity: z.record(z.string(), z.number()).default({}),
  /** What the scorer disliked — powers the inline "why this scored" UI. */
  authenticityNotes: z.array(z.string()).default([]),
  editCount: z.number().int().nonnegative().default(0),
  scheduledFor: z.string().datetime().nullable().default(null),
  postedAt: z.string().datetime().nullable().default(null),
  redditId: z.string().nullable().default(null),
  permalink: z.string().nullable().default(null),
  /** Which generator produced it, and which model — needed for the learning loop. */
  generator: z
    .object({
      template: z.string(),
      model: z.string(),
      seed: z.string(),
      attempt: z.number().int().nonnegative().default(0),
    })
    .default({ template: 'unknown', model: 'none', seed: '0', attempt: 0 }),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
  updatedAt: z.string().datetime().default(() => new Date().toISOString()),
});
export type Draft = z.infer<typeof DraftSchema>;

export const DraftSetSchema = z.object({
  momentId: z.string(),
  drafts: z.array(DraftSchema),
  /** Styles that failed the authenticity gate after N attempts. */
  rejected: z
    .array(z.object({ style: DraftStyleSchema, reason: z.string(), bestScore: z.number() }))
    .default([]),
  voiceProfileId: z.string().nullable().default(null),
  generatedAt: z.string().datetime().default(() => new Date().toISOString()),
});
export type DraftSet = z.infer<typeof DraftSetSchema>;

/* ------------------------------------------------------------------ */
/* Voice profile (produced by @upvote/voice, consumed by the core)     */
/* ------------------------------------------------------------------ */

export const VoiceSourceSchema = z.enum(['reddit_post', 'reddit_comment', 'tweet', 'blog', 'readme', 'commit']);
export type VoiceSource = z.infer<typeof VoiceSourceSchema>;

export const VoiceSampleSchema = z.object({
  id: z.string(),
  source: VoiceSourceSchema,
  text: z.string().min(1),
  createdAt: z.string().datetime().optional(),
  /** Upvotes when known — used to weight high-performing writing higher. */
  score: z.number().optional(),
});
export type VoiceSample = z.infer<typeof VoiceSampleSchema>;

/**
 * A normalized style vector. Every field is a plain number in a known range so
 * the authenticity scorer can compute weighted distances without preprocessing.
 */
export const StyleVectorSchema = z.object({
  avgWordLength: z.number(),
  avgSentenceWords: z.number(),
  sentenceLengthVariance: z.number(),
  wordsPerPost: z.number(),
  typeTokenRatio: z.number(),
  rareWordRate: z.number(),
  commaPerSentence: z.number(),
  questionRate: z.number(),
  exclamationRate: z.number(),
  ellipsisRate: z.number(),
  emDashRate: z.number(),
  semicolonRate: z.number(),
  parenthesesRate: z.number(),
  /** 0 = terse/casual, 1 = formal/professional. */
  formality: z.number(),
  /** 0 = deadpan, 1 = very jokey. */
  humor: z.number(),
  /** Per 1000 chars. */
  emojiRate: z.number(),
  /** Per 1000 chars. */
  profanityRate: z.number(),
  contractionRate: z.number(),
  lowercaseRatio: z.number(),
  capsWordRatio: z.number(),
  firstPersonRate: z.number(),
  secondPersonRate: z.number(),
  bulletRatio: z.number(),
  codeBlockRate: z.number(),
  linkRate: z.number(),
  headerRate: z.number(),
  paragraphWords: z.number(),
  hedgeRate: z.number(),
  certaintyRate: z.number(),
});
export type StyleVector = z.infer<typeof StyleVectorSchema>;

export const VoiceProfileSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  version: z.number().int().positive().default(1),
  sampleCount: z.number().int().nonnegative().default(0),
  /** Mean style vector across the corpus. */
  vector: StyleVectorSchema,
  /** Per-dimension spread, so the scorer can tolerate natural variance. */
  variance: StyleVectorSchema.partial().default({}),
  /** The founder's own words — used for n-gram similarity and lexical checks. */
  signaturePhrases: z.array(z.string()).default([]),
  favoriteWords: z.array(z.string()).default([]),
  bannedWords: z.array(z.string()).default([]),
  emojiFavorites: z.array(z.string()).default([]),
  openers: z.array(z.string()).default([]),
  closers: z.array(z.string()).default([]),
  /** 192-dim hashed embedding of the concatenated corpus. */
  embedding: z.array(z.number()).default([]),
  /** Human-editable overrides surfaced in the dashboard. */
  settings: z
    .object({
      formality: z.number().min(0).max(1).default(0.5),
      humor: z.number().min(0).max(1).default(0.3),
      emojiRate: z.number().min(0).max(20).default(1),
      profanityAllowed: z.boolean().default(false),
      ctaStyle: z.enum(['none', 'soft', 'direct']).default('soft'),
      bannedPhrases: z.array(z.string()).default([]),
    })
    .default({
      formality: 0.5,
      humor: 0.3,
      emojiRate: 1,
      profanityAllowed: false,
      ctaStyle: 'soft',
      bannedPhrases: [],
    }),
  trainedAt: z.string().datetime().default(() => new Date().toISOString()),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

/* ------------------------------------------------------------------ */
/* Subreddits                                                           */
/* ------------------------------------------------------------------ */

export const SubredditRuleSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'no_links',
    'no_selfpromo',
    'title_format',
    'flair_required',
    'no_markdown',
    'karma_age',
    'no_crosspost',
    'text_only',
    'min_account_age_days',
    'weekly_post_limit',
    'title_length',
    'no_external_link_first_paragraph',
    'custom',
  ]),
  description: z.string(),
  severity: z.enum(['hard', 'soft']).default('hard'),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type SubredditRule = z.infer<typeof SubredditRuleSchema>;

export const SubredditProfileSchema = z.object({
  name: z.string(),
  displayName: z.string().default(''),
  subscribers: z.number().int().nonnegative().nullable().default(null),
  activeUsers: z.number().int().nonnegative().nullable().default(null),
  /** 0-100 composite of size and liveliness. */
  activity: z.number().min(0).max(100).nullable().default(null),
  /** Median upvote ratio; null when unknown. */
  upvoteRatio: z.number().min(0).max(1).nullable().default(null),
  postsPerDay: z.number().nonnegative().nullable().default(null),
  over18: z.boolean().default(false),
  restricted: z.boolean().default(false),
  quarantined: z.boolean().default(false),
  description: z.string().default(''),
  sidebar: z.string().default(''),
  rules: z.array(SubredditRuleSchema).default([]),
  flairs: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
  /** Hour-of-day UTC scores 0-1, from observed activity. */
  activityByHourUtc: z.array(z.number()).default([]),
  /** Topic tags inferred from sidebar + description + rules. */
  topics: z.array(z.string()).default([]),
  allowSelfPromo: z.boolean().default(false),
  allowLinks: z.boolean().default(true),
  requiresFlair: z.boolean().default(false),
  fetchedAt: z.string().datetime().default(() => new Date().toISOString()),
});
export type SubredditProfile = z.infer<typeof SubredditProfileSchema>;

/* ------------------------------------------------------------------ */
/* Analytics                                                            */
/* ------------------------------------------------------------------ */

export const PublishedPostSchema = z.object({
  id: z.string(),
  userId: z.string(),
  draftId: z.string(),
  subreddit: z.string(),
  redditId: z.string(),
  permalink: z.string(),
  title: z.string(),
  style: DraftStyleSchema,
  voiceScore: z.number().min(0).max(100),
  postedAt: z.string().datetime(),
  /** Tracked link with UTM parameters. */
  trackedUrl: z.string().nullable().default(null),
});
export type PublishedPost = z.infer<typeof PublishedPostSchema>;

export const PostMetricsSchema = z.object({
  postId: z.string(),
  capturedAt: z.string().datetime(),
  upvotes: z.number().int().default(0),
  downvotes: z.number().int().default(0),
  comments: z.number().int().default(0),
  score: z.number().int().default(0),
  upvoteRatio: z.number().min(0).max(1).default(0),
  impressions: z.number().int().default(0),
  clicks: z.number().int().default(0),
  signups: z.number().int().default(0),
  revenueCents: z.number().int().default(0),
});
export type PostMetrics = z.infer<typeof PostMetricsSchema>;

/* ------------------------------------------------------------------ */
/* Guardrails                                                           */
/* ------------------------------------------------------------------ */

export const GuardrailConfigSchema = z.object({
  maxPostsPerDay: z.number().int().positive().default(3),
  maxPostsPerSubredditPerWeek: z.number().int().positive().default(1),
  maxCommentsPerDay: z.number().int().positive().default(30),
  /** Hours after a removed post before posting is allowed again. */
  cooldownHoursAfterRemoval: z.number().int().positive().default(72),
  blocklist: z.array(z.string()).default([]),
  /** Subreddits that must be avoided (nsfw, politics, competitor-hating, etc). */
  avoidCategories: z.array(z.string()).default(['nsfw', 'politics', 'military', 'animals_only']),
  requireManualApproval: z.boolean().default(true),
  /** Never post in a subreddit the user has never commented in. */
  requirePriorEngagement: z.boolean().default(true),
  minAccountAgeDays: z.number().int().nonnegative().default(0),
  minAuthenticityScore: z.number().min(0).max(100).default(85),
});
export type GuardrailConfig = z.infer<typeof GuardrailConfigSchema>;

export const PostingHistoryEntrySchema = z.object({
  userId: z.string(),
  subreddit: z.string(),
  postedAt: z.string().datetime(),
  postId: z.string(),
  removed: z.boolean().default(false),
});
export type PostingHistoryEntry = z.infer<typeof PostingHistoryEntrySchema>;