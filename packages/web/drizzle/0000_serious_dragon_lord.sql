CREATE TYPE "public"."draft_status" AS ENUM('draft', 'review', 'approved', 'scheduled', 'posted', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."draft_style" AS ENUM('show_and_tell', 'story', 'question', 'data', 'comment_reply');--> statement-breakpoint
CREATE TYPE "public"."plan_id" AS ENUM('free', 'pro', 'team');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('live', 'removed', 'deleted');--> statement-breakpoint
CREATE TABLE "attribution_events" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text,
	"user_id" text,
	"kind" text NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"referer" text,
	"click_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"account_name" text,
	"expires_at" timestamp with time zone,
	"scopes" text,
	"account_karma" integer,
	"account_age_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"moment_id" text,
	"style" "draft_style" NOT NULL,
	"status" "draft_status" DEFAULT 'review' NOT NULL,
	"title" text NOT NULL,
	"title_variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_title_variant" integer DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"first_comment" text DEFAULT '' NOT NULL,
	"flair" text DEFAULT '' NOT NULL,
	"flair_id" text,
	"link_url" text,
	"suggested_subreddits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_subreddit" text,
	"authenticity_score" real DEFAULT 0 NOT NULL,
	"authenticity_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"authenticity_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"generator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scheduled_for" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"reddit_id" text,
	"permalink" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"upvote_ratio" real DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"signups" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"draft_id" text,
	"subreddit" text NOT NULL,
	"reddit_id" text NOT NULL,
	"permalink" text NOT NULL,
	"title" text NOT NULL,
	"style" "draft_style" NOT NULL,
	"voice_score" real DEFAULT 0 NOT NULL,
	"tracked_url" text,
	"status" "post_status" DEFAULT 'live' NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"max_posts_per_day" integer DEFAULT 3 NOT NULL,
	"max_posts_per_subreddit_week" integer DEFAULT 1 NOT NULL,
	"cooldown_hours_after_removal" integer DEFAULT 72 NOT NULL,
	"blocklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"require_manual_approval" boolean DEFAULT true NOT NULL,
	"require_prior_engagement" boolean DEFAULT true NOT NULL,
	"min_authenticity_score" real DEFAULT 85 NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"digest_hour_utc" integer DEFAULT 8 NOT NULL,
	"billing_customer_id" text,
	"billing_subscription_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_moments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"what_changed" text DEFAULT '' NOT NULL,
	"lesson" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repo_owner" text,
	"repo_name" text,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subreddit_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subscribers" integer,
	"activity" real,
	"upvote_ratio" real,
	"allow_self_promo" boolean DEFAULT false NOT NULL,
	"allow_links" boolean DEFAULT true NOT NULL,
	"requires_flair" boolean DEFAULT false NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flairs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activity_by_hour_utc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"best_hours_utc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subreddit_profiles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"plan" "plan_id" DEFAULT 'free' NOT NULL,
	"product_url" text,
	"product_name" text,
	"timezone_offset_minutes" integer DEFAULT 0 NOT NULL,
	"onboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id")
);
--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"quality_score" integer DEFAULT 0 NOT NULL,
	"ready_for_production" boolean DEFAULT false NOT NULL,
	"vector" jsonb NOT NULL,
	"variance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"favorite_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"banned_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"profile_id" text,
	"source" text NOT NULL,
	"text" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watched_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"branch" text DEFAULT 'main',
	"shippable_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_post_id_published_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."published_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_moment_id_shipping_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."shipping_moments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_published_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."published_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_moments" ADD CONSTRAINT "shipping_moments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_profile_id_voice_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."voice_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watched_repos" ADD CONSTRAINT "watched_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attribution_events_post_idx" ON "attribution_events" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "attribution_events_click_idx" ON "attribution_events" USING btree ("click_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_user_provider_idx" ON "connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "drafts_user_status_idx" ON "drafts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "drafts_schedule_idx" ON "drafts" USING btree ("scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "post_metrics_post_time_idx" ON "post_metrics" USING btree ("post_id","captured_at");--> statement-breakpoint
CREATE INDEX "published_posts_user_idx" ON "published_posts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "published_posts_subreddit_idx" ON "published_posts" USING btree ("subreddit");--> statement-breakpoint
CREATE INDEX "shipping_moments_user_idx" ON "shipping_moments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_moments_dedupe_idx" ON "shipping_moments" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "subreddit_profiles_activity_idx" ON "subreddit_profiles" USING btree ("activity");--> statement-breakpoint
CREATE INDEX "users_clerk_idx" ON "users" USING btree ("clerk_id");--> statement-breakpoint
CREATE INDEX "voice_profiles_user_idx" ON "voice_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "voice_samples_user_idx" ON "voice_samples" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watched_repos_user_repo_idx" ON "watched_repos" USING btree ("user_id","owner","repo");