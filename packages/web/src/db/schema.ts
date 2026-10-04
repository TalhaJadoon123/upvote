/**
 * Drizzle schema for the Upvote dashboard.
 *
 * Ten tables, one job each. The CLI's JSON store and this schema intentionally
 * carry the same fields so a founder can start in the CLI and move to the
 * dashboard without losing drafts.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ */
/* Enums                                                                */
/* ------------------------------------------------------------------ */

export const draftStatus = pgEnum('draft_status', [
  'draft',
  'review',
  'approved',
  'scheduled',
  'posted',
  'failed',
  'rejected',
]);

export const draftStyle = pgEnum('draft_style', [
  'show_and_tell',
  'story',
  'question',
  'data',
  'comment_reply',
]);

export const postStatus = pgEnum('post_status', [
  'live',
  'removed',
  'deleted',
]);

export const planId = pgEnum('plan_id', ['free', 'pro', 'team']);

/* ------------------------------------------------------------------ */
/* Core tables                                                          */
/* ------------------------------------------------------------------ */

/** Clerk user id -> Upvote user. */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    clerkId: text('clerk_id').notNull().unique(),
    email: text('email').notNull(),
    name: text('name'),
    plan: planId('plan').notNull().default('free'),
    productUrl: text('product_url'),
    productName: text('product_name'),
    timezoneOffsetMinutes: integer('timezone_offset_minutes').notNull().default(0),
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_clerk_idx').on(t.clerkId)],
);

/** Encrypted OAuth tokens. Never store these in plaintext. */
export const connections = pgTable(
  'connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** Access + refresh tokens, encrypted at rest. */
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    /** Reddit account name, GitHub login. */
    accountName: text('account_name'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes'),
    /** Only used by Reddit: karma and account age gate some subreddits. */
    accountKarma: integer('account_karma'),
    accountAgeDays: integer('account_age_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connections_user_provider_idx').on(t.userId, t.provider)],
);

/** Repositories whose shipping moments trigger drafts. */
export const watchedRepos = pgTable(
  'watched_repos',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    branch: text('branch').default('main'),
    /** Per-repo PR labels that mean "postable". */
    shippableLabels: jsonb('shippable_labels').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('watched_repos_user_repo_idx').on(t.userId, t.owner, t.repo)],
);

/** The trained voice profile: JSON blob plus the vectors we query against. */
export const voiceProfiles = pgTable(
  'voice_profiles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    sampleCount: integer('sample_count').notNull().default(0),
    qualityScore: integer('quality_score').notNull().default(0),
    readyForProduction: boolean('ready_for_production').notNull().default(false),
    /** The full StyleVector, so we can compare without re-parsing. */
    vector: jsonb('vector').$type<Record<string, number>>().notNull(),
    variance: jsonb('variance').$type<Record<string, number>>().notNull().default({}),
    signaturePhrases: jsonb('signature_phrases').$type<string[]>().notNull().default([]),
    favoriteWords: jsonb('favorite_words').$type<string[]>().notNull().default([]),
    bannedWords: jsonb('banned_words').$type<string[]>().notNull().default([]),
    embedding: jsonb('embedding').$type<number[]>().notNull().default([]),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    trainedAt: timestamp('trained_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('voice_profiles_user_idx').on(t.userId)],
);

/** Raw writing samples, so a profile can be rebuilt or audited. */
export const voiceSamples = pgTable(
  'voice_samples',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    profileId: text('profile_id').references(() => voiceProfiles.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    text: text('text').notNull(),
    score: integer('score').notNull().default(0),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('voice_samples_user_idx').on(t.userId)],
);

/** The raw signal from GitHub. */
export const shippingMoments = pgTable(
  'shipping_moments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    whatChanged: text('what_changed').notNull().default(''),
    lesson: text('lesson').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    source: jsonb('source').$type<Record<string, unknown>>().notNull().default({}),
    repoOwner: text('repo_owner'),
    repoName: text('repo_name'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipping_moments_user_idx').on(t.userId),
    uniqueIndex('shipping_moments_dedupe_idx').on(t.userId, t.id),
  ],
);

/** Drafts, including every generated variant's scores and suggestions. */
export const drafts = pgTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    momentId: text('moment_id').references(() => shippingMoments.id, { onDelete: 'set null' }),
    style: draftStyle('style').notNull(),
    status: draftStatus('status').notNull().default('review'),
    title: text('title').notNull(),
    titleVariants: jsonb('title_variants').$type<string[]>().notNull().default([]),
    selectedTitleVariant: integer('selected_title_variant').notNull().default(0),
    body: text('body').notNull(),
    firstComment: text('first_comment').notNull().default(''),
    flair: text('flair').notNull().default(''),
    flairId: text('flair_id'),
    linkUrl: text('link_url'),
    suggestedSubreddits: jsonb('suggested_subreddits')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    primarySubreddit: text('primary_subreddit'),
    authenticityScore: real('authenticity_score').notNull().default(0),
    authenticityBreakdown: jsonb('authenticity_breakdown').$type<Record<string, number>>().notNull().default({}),
    authenticityNotes: jsonb('authenticity_notes').$type<string[]>().notNull().default([]),
    editCount: integer('edit_count').notNull().default(0),
    generator: jsonb('generator').$type<Record<string, unknown>>().notNull().default({}),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    redditId: text('reddit_id'),
    permalink: text('permalink'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('drafts_user_status_idx').on(t.userId, t.status),
    index('drafts_schedule_idx').on(t.scheduledFor),
  ],
);

/** Cached subreddit metadata + parsed rules. */
export const subredditProfiles = pgTable(
  'subreddit_profiles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    subscribers: integer('subscribers'),
    activity: real('activity'),
    upvoteRatio: real('upvote_ratio'),
    allowSelfPromo: boolean('allow_self_promo').notNull().default(false),
    allowLinks: boolean('allow_links').notNull().default(true),
    requiresFlair: boolean('requires_flair').notNull().default(false),
    topics: jsonb('topics').$type<string[]>().notNull().default([]),
    rules: jsonb('rules').$type<Array<Record<string, unknown>>>().notNull().default([]),
    flairs: jsonb('flairs').$type<Array<{ id: string; text: string }>>().notNull().default([]),
    /** 24 hourly activity scores, UTC. */
    activityByHourUtc: jsonb('activity_by_hour_utc').$type<number[]>().notNull().default([]),
    bestHoursUtc: jsonb('best_hours_utc').$type<number[]>().notNull().default([]),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('subreddit_profiles_activity_idx').on(t.activity)],
);

/** Posts we published. */
export const publishedPosts = pgTable(
  'published_posts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    draftId: text('draft_id').references(() => drafts.id, { onDelete: 'set null' }),
    subreddit: text('subreddit').notNull(),
    redditId: text('reddit_id').notNull(),
    permalink: text('permalink').notNull(),
    title: text('title').notNull(),
    style: draftStyle('style').notNull(),
    voiceScore: real('voice_score').notNull().default(0),
    trackedUrl: text('tracked_url'),
    status: postStatus('status').notNull().default('live'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('published_posts_user_idx').on(t.userId),
    index('published_posts_subreddit_idx').on(t.subreddit),
  ],
);

/** Time series of metrics per post. */
export const postMetrics = pgTable(
  'post_metrics',
  {
    id: text('id').primaryKey(),
    postId: text('post_id').notNull().references(() => publishedPosts.id, { onDelete: 'cascade' }),
    upvotes: integer('upvotes').notNull().default(0),
    downvotes: integer('downvotes').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    score: integer('score').notNull().default(0),
    upvoteRatio: real('upvote_ratio').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    signups: integer('signups').notNull().default(0),
    revenueCents: integer('revenue_cents').notNull().default(0),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('post_metrics_post_time_idx').on(t.postId, t.capturedAt)],
);

/** Click and signup events, joined to a post via the tracked link id. */
export const attributionEvents = pgTable(
  'attribution_events',
  {
    id: text('id').primaryKey(),
    postId: text('post_id').references(() => publishedPosts.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    revenueCents: integer('revenue_cents').notNull().default(0),
    referer: text('referer'),
    /** The `upv` click id from the tracked link. */
    clickId: text('click_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attribution_events_post_idx').on(t.postId),
    index('attribution_events_click_idx').on(t.clickId),
  ],
);

/** Guardrails per user, one row. */
export const settings = pgTable('settings', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  maxPostsPerDay: integer('max_posts_per_day').notNull().default(3),
  maxPostsPerSubredditPerWeek: integer('max_posts_per_subreddit_week').notNull().default(1),
  cooldownHoursAfterRemoval: integer('cooldown_hours_after_removal').notNull().default(72),
  blocklist: jsonb('blocklist').$type<string[]>().notNull().default([]),
  allowlist: jsonb('allowlist').$type<string[]>().notNull().default([]),
  requireManualApproval: boolean('require_manual_approval').notNull().default(true),
  requirePriorEngagement: boolean('require_prior_engagement').notNull().default(true),
  minAuthenticityScore: real('min_authenticity_score').notNull().default(85),
  /** Digest email cadence. */
  digestEnabled: boolean('digest_enabled').notNull().default(true),
  digestHourUtc: integer('digest_hour_utc').notNull().default(8),
  billingCustomerId: text('billing_customer_id'),
  billingSubscriptionId: text('billing_subscription_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Inferred relationships                                              */
/* ------------------------------------------------------------------ */

export const usersRelations = { connections: connections, drafts: drafts, profile: voiceProfiles };
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type DraftRow = typeof drafts.$inferSelect;
export type NewDraft = typeof drafts.$inferInsert;
export type VoiceProfileRow = typeof voiceProfiles.$inferSelect;
export type PublishedPostRow = typeof publishedPosts.$inferSelect;
export type SubredditProfileRow = typeof subredditProfiles.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;