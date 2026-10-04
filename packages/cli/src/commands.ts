/**
 * CLI command implementations.
 *
 * Every command is a pure-ish function over (args, config, state) so the tests can
 * drive them without spawning a process. bin.ts only does argument parsing.
 */
import { spawnSync } from 'node:child_process';
import {
  DISTRIBUTION_TEMPLATES,
  GuardrailConfigSchema,
  checkEntitlement,
  clientFromEnv,
  defaultSubredditPool,
  evaluateGuardrails,
  formatInUserTimezone,
  generateDraftSet,
  inferTopics,
  momentFromText,
  planById,
  predictBestTimes,
  suggestReply,
  type Draft,
  type DraftStyle,
  type ShippingMoment,
  type VoiceSample,
} from '@upvote/core';
import { describeProfile as describeVoice, trainVoiceProfile, balanceSamples, deduplicateSamples, samplesFromRedditListing } from '@upvote/voice';
import { GitHubClient, inferTags, momentFromWebhook } from '@upvote/gh';
import { pickFlairId, RedditClient } from '@upvote/reddit';
import {
  buildWeeklyReport,
  computePerformance,
  computeLearning,
  createStore,
  recordMetrics,
  recordPost,
  summarize,
  type AnalyticsStore,
} from '@upvote/analytics';
import {
  completeItem,
  claimItem,
  describeQueue,
  scheduleDraft,
  tick,
  upcoming,
  type SchedulerState,
} from '@upvote/scheduler';
import type { CliConfig, CliState } from './store.js';
import { saveConfig, saveState, maskSecret, CONFIG_DIR } from './store.js';
import * as ui from './ui.js';

export interface CommandContext {
  config: CliConfig;
  state: CliState;
  /** Where output goes. Swapped in tests. */
  out: (line?: string) => void;
  /** Set by commands that need a browser or network input the CLI cannot do. */
  now?: Date;
}

const STYLE_LABEL: Record<DraftStyle, string> = {
  show_and_tell: 'Show & tell',
  story: 'Story',
  question: 'Question',
  data: 'Data',
  comment_reply: 'Comment reply',
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function schedulerState(ctx: CommandContext): SchedulerState {
  return {
    items: ctx.state.drafts
      .filter((d) => d.status === 'scheduled' && d.scheduledFor)
      .map((d) => ({
        draftId: d.id,
        userId: d.userId,
        subreddit: d.primarySubreddit ?? 'unknown',
        runAt: d.scheduledFor!,
        reason: 'scheduled in the dashboard',
        attempts: 0,
        status: 'scheduled' as const,
      })),
    history: ctx.state.history,
    config: ctx.config.guardrails,
  };
}

function persistScheduler(ctx: CommandContext, sched: SchedulerState): void {
  const byId = new Map(sched.items.map((i) => [i.draftId, i]));
  for (const draft of ctx.state.drafts) {
    const item = byId.get(draft.id);
    if (!item) continue;
    draft.status = item.status === 'published' ? 'posted' : 'scheduled';
    draft.scheduledFor = item.runAt;
  }
  ctx.state.history = sched.history;
}

function redditClient(ctx: CommandContext): RedditClient {
  return new RedditClient({
    clientId: ctx.config.reddit.clientId,
    clientSecret: ctx.config.reddit.clientSecret,
    redirectUri: ctx.config.reddit.redirectUri,
    tokens: ctx.config.reddit.tokens,
  });
}

function subredditProfiles(ctx: CommandContext) {
  const stored = Object.values(ctx.state.subredditProfiles);
  return (stored.length > 0 ? stored : defaultSubredditPool()) as ReturnType<typeof defaultSubredditPool>;
}

function requireVoiceProfile(ctx: CommandContext) {
  const profile = ctx.state.voiceProfile;
  if (!profile) {
    throw new Error('No voice profile yet. Run `upvote voice train` first.');
  }
  return profile;
}

function outHeader(ctx: CommandContext, text: string): void {
  ctx.out(ui.heading(text));
}

/* ------------------------------------------------------------------ */
/* connect                                                              */
/* ------------------------------------------------------------------ */

export async function cmdConnect(
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  const target = args[0] ?? 'all';
  const token = args.find((a) => a.startsWith('--token='))?.split('=')[1];
  if (token) {
    ctx.config.githubToken = token;
    saveConfig(ctx.config);
    ctx.out(ui.success('GitHub token saved.'));
  }

  if (target === 'github' || target === 'all') {
    const gh = new GitHubClient({ token: ctx.config.githubToken ?? token });
    if (!gh.authenticated) {
      ctx.out(ui.warn('No GitHub token. Create one at https://github.com/settings/tokens (scope: repo).'));
      ctx.out(ui.dim('        Then run: upvote connect github --token=ghp_xxx'));
    } else {
      try {
        const me = await gh.authenticatedUser();
        ctx.out(ui.success(`GitHub connected as ${me.login}.`));
      } catch (error) {
        ctx.out(ui.fail(`GitHub token rejected: ${(error as Error).message}`));
      }
    }
  }

  if (target === 'reddit' || target === 'all') {
    if (!ctx.config.reddit.clientId) {
      ctx.out(ui.info('To connect Reddit, create a script app at https://www.reddit.com/prefs/apps'));
      ctx.out(ui.dim('  Set the redirect URI to: ' + ctx.config.reddit.redirectUri));
      ctx.out(ui.dim('  Then: upvote config reddit --client-id=ID --client-secret=SECRET'));
      ctx.out(ui.dim('  Then: upvote connect reddit   (prints the URL to open)'));
    } else {
      const client = redditClient(ctx);
      if (client.authenticated) {
        const me = await client.me();
        ctx.config.reddit.accountName = me.name;
        ctx.config.reddit.accountAgeDays = Math.max(
          0,
          Math.floor((Date.now() - me.createdUtc * 1000) / 86_400_000),
        );
        saveConfig(ctx.config);
        ctx.out(ui.success(`Reddit connected as u/${me.name} (account ${ctx.config.reddit.accountAgeDays} days old).`));
      } else {
        ctx.out(ui.info('Open this URL, approve, then paste the code back here:'));
        const state = Math.random().toString(36).slice(2);
        ctx.out('  ' + client.authorizeUrl(state));
        ctx.out(ui.dim('  Then run: upvote connect reddit --code=PASTE_CODE'));
      }
    }
  }

  if (target === 'reddit' && args.includes('--code')) {
    const code = args.find((a) => a.startsWith('--code='))?.split('=')[1];
    if (code) {
      const client = redditClient(ctx);
      const tokens = await client.exchangeCode(code);
      ctx.config.reddit.tokens = tokens;
      const me = await client.me();
      ctx.config.reddit.accountName = me.name;
      saveConfig(ctx.config);
      ctx.out(ui.success(`Reddit connected as u/${me.name}.`));
    }
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/* voice train                                                          */
/* ------------------------------------------------------------------ */

export async function cmdVoiceTrain(args: string[], ctx: CommandContext): Promise<number> {
  outHeader(ctx, 'Voice training');
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 100);
  const fromFile = args.find((a) => a.startsWith('--file='))?.split('=')[1];

  let samples: VoiceSample[] = ctx.state.samples;

  if (fromFile) {
    // A text file of the founder's real writing, one sample per blank-line block.
    const fs = await import('node:fs');
    const raw = fs.readFileSync(fromFile, 'utf8');
    samples = [
      ...samples,
      ...raw
        .split(/\n\s*\n/)
        .map((block, i) => ({ id: `file_${i}`, source: 'reddit_post' as const, text: block.trim(), score: 0 }))
        .filter((s) => s.text.length >= 40),
    ];
    ctx.out(ui.info(`Loaded ${samples.length} samples from ${fromFile}`));
  } else {
    const client = redditClient(ctx);
    if (client.authenticated) {
      const children = await client.getMyActivity({ limit });
      const fresh = samplesFromRedditListing(children as never);
      samples = dedupe([...samples, ...fresh]);
      ctx.out(ui.info(`Fetched ${fresh.length} items from Reddit.`));
    } else {
      ctx.out(ui.warn('Not connected to Reddit - training on stored samples only.'));
    }
  }

  const balanced = balanceSamples(deduplicateSamples(samples));
  if (balanced.length === 0) {
    ctx.out(ui.fail('No usable samples. Connect Reddit or pass --file=notes.md'));
    return 1;
  }

  const { profile, quality } = trainVoiceProfile(balanced, {
    userId: ctx.config.userId,
    version: (ctx.state.voiceProfile?.version ?? 0) + 1,
    ...(args.includes('--profanity') ? { profanityAllowed: true } : {}),
  });

  ctx.state.samples = balanced;
  ctx.state.voiceProfile = profile;
  saveState(ctx.state);

  ctx.out(ui.success(`Trained on ${balanced.length} samples (v${profile.version}).`));
  ctx.out(ui.bullet(`Voice: ${describeVoice(profile)}`));
  ctx.out(ui.bullet(`Quality: ${quality.score}/100 ${quality.readyForProduction ? ui.green('ready') : ui.yellow('needs more samples')}`));
  if (profile.signaturePhrases.length > 0) {
    ctx.out(ui.bullet(`Signature phrasing: ${profile.signaturePhrases.slice(0, 5).map((p) => `"${p}"`).join(', ')}`));
  }
  for (const warning of quality.warnings) ctx.out(ui.bullet(ui.dim(warning)));
  return 0;
}

function dedupe(samples: VoiceSample[]): VoiceSample[] {
  const seen = new Set<string>();
  return samples.filter((s) => {
    const key = `${s.source}:${s.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* draft                                                                */
/* ------------------------------------------------------------------ */

export async function cmdDraft(args: string[], ctx: CommandContext): Promise<number> {
  const profile = requireVoiceProfile(ctx);
  const plan = planById(ctx.config.plan);

  const text = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!text) {
    ctx.out(ui.fail('Describe what you shipped, e.g. `upvote draft "fixed the retry cache in my ingest layer"`'));
    return 1;
  }

  const tagArg = args.find((a) => a.startsWith('--tags='))?.split('=')[1];
  const tags = (tagArg ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const moment = enrichMoment(momentFromText(text, tags));

  const monthCount = ctx.state.drafts.filter((d) => d.createdAt.slice(0, 7) === new Date().toISOString().slice(0, 7)).length;
  const entitlement = checkEntitlement(plan, 'draft', monthCount);
  if (!entitlement.allowed) {
    ctx.out(ui.fail(entitlement.reason ?? 'Plan limit reached.'));
    return 1;
  }

  outHeader(ctx, `Drafts for: ${ui.truncate(moment.title, 70)}`);
  const set = await generateDraftSet(moment, {
    userId: ctx.config.userId,
    profile,
    subreddits: subredditProfiles(ctx),
    model: clientFromEnv(),
    ...(ctx.config.product.name ? { productName: ctx.config.product.name } : {}),
    engagedSubreddits: ctx.state.engagedSubreddits,
    history: ctx.state.engagedSubreddits,
    linkUrl: ctx.config.product.url ?? null,
  });

  ctx.state.drafts = [...set.drafts, ...ctx.state.drafts];
  saveState(ctx.state);

  for (const draft of set.drafts) printDraft(ctx, draft);
  for (const rejection of set.rejected) {
    ctx.out(ui.warn(`${STYLE_LABEL[rejection.style]}: ${rejection.reason}`));
  }
  if (set.drafts.length === 0) {
    ctx.out(ui.fail('Nothing cleared the voice bar. Add more of your own writing to `upvote voice train --file=`.'));
  } else {
    ctx.out('');
    ctx.out(ui.dim(`  Approve with: upvote approve ${set.drafts[0]!.id}`));
    ctx.out(ui.dim(`  Show all:    upvote list`));
  }
  return set.drafts.length > 0 ? 0 : 1;
}

function enrichMoment(moment: ShippingMoment): ShippingMoment {
  const tags = moment.tags.length > 0 ? moment.tags : inferTopics(`${moment.title} ${moment.body}`).topics;
  return { ...moment, tags: [...new Set([...tags, ...inferTags(`${moment.title} ${moment.body}`)])] };
}

function printDraft(ctx: CommandContext, draft: Draft): void {
  const sub = draft.primarySubreddit ? `r/${draft.primarySubreddit}` : 'no subreddit matched';
  ctx.out('');
  ctx.out(`${ui.bold(draft.title)}`);
  ctx.out(ui.dim(`  ${STYLE_LABEL[draft.style]} · ${sub} · voice ${ui.score(draft.authenticityScore)}${draft.authenticityScore >= (ctx.config.guardrails.minAuthenticityScore ?? 85) ? ui.green(' ✓') : ui.red(' ✗')}`));
  if (draft.scheduledFor) {
    ctx.out(ui.dim(`  best time: ${formatInUserTimezone(draft.scheduledFor, ctx.config.timezoneOffsetMinutes)}`));
  }
  ctx.out('');
  for (const paragraph of draft.body.split(/\n{2,}/)) ctx.out(`  ${paragraph}`);
  if (draft.firstComment) {
    ctx.out('');
    ctx.out(ui.dim('  first comment:'));
    ctx.out(`  ${ui.dim(draft.firstComment)}`);
  }
  const violations = draft.suggestedSubreddits.filter((s) => !s.compliant);
  for (const v of violations.slice(0, 2)) ctx.out(ui.warn(`${v.subreddit}: ${v.violations[0]}`));
  ctx.out(ui.dim(`  id: ${draft.id}`));
}

/* ------------------------------------------------------------------ */
/* list / show                                                          */
/* ------------------------------------------------------------------ */

export function cmdList(args: string[], ctx: CommandContext): number {
  const statusFilter = args.find((a) => !a.startsWith('-'));
  let drafts = ctx.state.drafts;
  if (statusFilter && ['draft', 'review', 'approved', 'scheduled', 'posted', 'failed'].includes(statusFilter)) {
    drafts = drafts.filter((d) => d.status === statusFilter);
  }

  outHeader(ctx, `Draft queue (${drafts.length})`);
  if (drafts.length === 0) {
    ctx.out(ui.dim('  No drafts yet. Try `upvote draft "what you shipped"`'));
    return 0;
  }

  const rows = drafts.slice(0, 40).map((d) => [
    d.id,
    ui.score(d.authenticityScore),
    STYLE_LABEL[d.style].padEnd(13),
    d.primarySubreddit ? `r/${d.primarySubreddit}` : '-',
    d.status,
    ui.truncate(d.title, 44),
  ]);
  ctx.out(ui.table(['ID', 'VOICE', 'STYLE', 'SUBREDDIT', 'STATUS', 'TITLE'], rows));
  return 0;
}

export function cmdShow(args: string[], ctx: CommandContext): number {
  const id = args[0];
  const draft = ctx.state.drafts.find((d) => d.id === id || d.id.endsWith(id ?? '\u0000'));
  if (!draft) {
    ctx.out(ui.fail(`No draft with id ${id}. Run \`upvote list\`.`));
    return 1;
  }
  outHeader(ctx, draft.title);
  printDraft(ctx, draft);
  ctx.out('');
  for (const [label, value] of Object.entries(draft.authenticity)) {
    ctx.out(`  ${ui.dim(label.padEnd(18))} ${String(value).padStart(5)}`);
  }
  if (draft.authenticityNotes.length > 0) {
    ctx.out('');
    for (const note of draft.authenticityNotes) ctx.out(ui.bullet(ui.dim(note)));
  }
  if (draft.suggestedSubreddits.length > 0) {
    ctx.out('');
    ctx.out(ui.bold('  Subreddit suggestions'));
    for (const s of draft.suggestedSubreddits) {
      const mark = s.compliant ? ui.green('ok') : ui.red('blocked');
      ctx.out(`  ${mark} r/${s.subreddit} ${String(Math.round(s.fit)).padStart(3)}  ${ui.dim(s.reasons.join(', '))}`);
      for (const v of s.violations) ctx.out(`      ${ui.red(v)}`);
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* approve / schedule / post                                            */
/* ------------------------------------------------------------------ */

export async function cmdApprove(args: string[], ctx: CommandContext): Promise<number> {
  const id = args[0];
  const draft = ctx.state.drafts.find((d) => d.id === id || d.id.endsWith(id ?? '\u0000'));
  if (!draft) {
    ctx.out(ui.fail(`No draft with id ${id}.`));
    return 1;
  }

  const subredditArg = args.find((a) => a.startsWith('--subreddit='))?.split('=')[1];
  const sub = subredditArg ?? draft.primarySubreddit;
  if (!sub) {
    ctx.out(ui.fail('No subreddit chosen. Re-run matching with `upvote sub match` or pass --subreddit='));
    return 1;
  }

  const decision = evaluateGuardrails({
    userId: ctx.config.userId,
    subreddit: sub,
    history: ctx.state.history,
    // Drafts already queued count against the weekly cap too - otherwise the
    // queue happily schedules four posts into one subreddit in a week.
    pending: ctx.state.drafts
      .filter((d) => d.status === 'scheduled' && d.scheduledFor && d.id !== draft.id)
      .map((d) => ({ subreddit: d.primarySubreddit ?? '', scheduledFor: d.scheduledFor! })),
    approved: true,
    authenticityScore: draft.authenticityScore,
    engagedSubreddits: ctx.state.engagedSubreddits,
    config: ctx.config.guardrails,
    ...(ctx.config.reddit.accountAgeDays !== undefined ? { accountAgeDays: ctx.config.reddit.accountAgeDays } : {}),
  });

  if (!decision.allowed) {
    ctx.out(ui.fail('Blocked by your guardrails:'));
    for (const message of decision.messages) ctx.out(ui.bullet(message));
    if (decision.retryAfter) ctx.out(ui.dim(`  Earliest allowed: ${decision.retryAfter}`));
    ctx.out('');
    ctx.out(ui.dim('  Loosen them in settings, or edit the draft and re-approve.'));
    return 1;
  }

  const sched = schedulerState(ctx);
  const item = scheduleDraft(sched, { ...draft, primarySubreddit: sub }, {
    now: new Date(),
    subreddits: subredditProfiles(ctx),
  });
  if (!item) {
    ctx.out(ui.fail('Could not find a legal slot - guardrails are blocking every candidate.'));
    return 1;
  }

  draft.status = 'scheduled';
  draft.primarySubreddit = item.subreddit;
  draft.scheduledFor = item.runAt;
  persistScheduler(ctx, sched);
  saveState(ctx.state);

  ctx.out(ui.success(`Scheduled for r/${item.subreddit} at ${formatInUserTimezone(item.runAt, ctx.config.timezoneOffsetMinutes)}`));
  ctx.out(ui.dim(`  ${item.reason}`));
  if (args.includes('--now')) return cmdPost([draft.id, '--now'], ctx);
  return 0;
}

export async function cmdPost(args: string[], ctx: CommandContext): Promise<number> {
  const id = args[0];
  const draft = ctx.state.drafts.find((d) => d.id === id || d.id.endsWith(id ?? '\u0000'));
  if (!draft) {
    ctx.out(ui.fail(`No draft with id ${id}.`));
    return 1;
  }
  if (!draft.primarySubreddit) {
    ctx.out(ui.fail('No subreddit set. Run `upvote approve` first.'));
    return 1;
  }

  const client = redditClient(ctx);
  if (!client.authenticated) {
    ctx.out(ui.fail('Not connected to Reddit. Run `upvote connect reddit`.'));
    return 1;
  }

  // Re-check the rules at publish time: sidebars change.
  const profile = subredditProfiles(ctx).find((p) => p.name === draft.primarySubreddit);
  if (profile) {
    const { checkCompliance } = await import('@upvote/core');
    const check = checkCompliance(profile, {
      title: draft.title,
      body: draft.body,
      firstComment: draft.firstComment,
      linkUrl: draft.linkUrl,
      ...(ctx.config.product.name ? { productName: ctx.config.product.name } : {}),
    });
    if (!check.compliant) {
      ctx.out(ui.fail(`r/${draft.primarySubreddit} rules have changed:`));
      for (const v of check.violations) ctx.out(ui.bullet(v));
      return 1;
    }
  }

  const flairId = profile?.flairs.length ? pickFlairId(profile.flairs, draft.flair) : undefined;
  let result;
  try {
    result = await client.submit({
      subreddit: draft.primarySubreddit,
      title: draft.title,
      text: draft.body,
      ...(flairId ? { flairId } : {}),
    });
  } catch (error) {
    ctx.out(ui.fail(`Post rejected: ${(error as Error).message}`));
    draft.status = 'failed';
    saveState(ctx.state);
    return 1;
  }

  const sched = schedulerState(ctx);
  claimItem(sched, draft.id);
  completeItem(sched, draft.id, result.id, new Date());

  const postId = `post_${draft.id.slice(-8)}`;
  draft.status = 'posted';
  draft.postedAt = new Date().toISOString();
  draft.redditId = result.id;
  draft.permalink = result.permalink;
  ctx.state.posts.push({
    id: postId,
    userId: ctx.config.userId,
    draftId: draft.id,
    subreddit: draft.primarySubreddit,
    redditId: result.id,
    permalink: result.permalink,
    title: draft.title,
    style: draft.style,
    voiceScore: draft.authenticityScore,
    postedAt: draft.postedAt,
    trackedUrl: ctx.config.product.url ?? null,
  });
  ctx.state.history = sched.history;
  saveState(ctx.state);

  ctx.out(ui.success(`Posted to r/${draft.primarySubreddit}`));
  ctx.out(`  ${ui.link(draft.title, result.permalink)}`);

  if (draft.firstComment) {
    ctx.out('');
    ctx.out(ui.dim('  Suggested first comment (paste it yourself - we never post it without you):'));
    ctx.out(`  ${draft.firstComment}`);
  }
  ctx.out('');
  ctx.out(ui.dim(`  Upvote tracking: upvote metrics ${postId}`));
  return 0;
}

/* ------------------------------------------------------------------ */
/* schedule / metrics / analyze                                         */
/* ------------------------------------------------------------------ */

export async function cmdSchedule(args: string[], ctx: CommandContext): Promise<number> {
  const now = ctx.now ?? new Date();
  const sched = schedulerState(ctx);

  if (args.includes('--tick')) {
    const client = redditClient(ctx);
    if (!client.authenticated) {
      ctx.out(ui.fail('Not connected to Reddit.'));
      return 1;
    }
    const result = await tick({
      state: sched,
      publish: async (item) => {
        const draft = ctx.state.drafts.find((d) => d.id === item.draftId);
        if (!draft) throw new Error(`draft ${item.draftId} vanished`);
        const r = await client.submit({
          subreddit: item.subreddit,
          title: draft.title,
          text: draft.body,
        });
        recordPost(toStore(ctx.state), {
          id: `post_${draft.id.slice(-8)}`,
          userId: ctx.config.userId,
          draftId: draft.id,
          subreddit: item.subreddit,
          redditId: r.id,
          permalink: r.permalink,
          title: draft.title,
          style: draft.style,
          voiceScore: draft.authenticityScore,
          postedAt: new Date().toISOString(),
          trackedUrl: ctx.config.product.url ?? null,
        });
        draft.status = 'posted';
        draft.postedAt = new Date().toISOString();
        draft.redditId = r.id;
        draft.permalink = r.permalink;
      },
      now,
    });
    persistScheduler(ctx, sched);
    saveState(ctx.state);
    ctx.out(ui.success(`Published ${result.processed} post(s), ${result.failed} failed.`));
    return 0;
  }

  // Otherwise: fill the queue from approved drafts.
  const approved = ctx.state.drafts.filter((d) => d.status === 'approved' && d.primarySubreddit);
  let scheduled = 0;
  for (const draft of approved) {
    const item = scheduleDraft(sched, draft, { now, subreddits: subredditProfiles(ctx) });
    if (item) {
      draft.status = 'scheduled';
      draft.scheduledFor = item.runAt;
      scheduled++;
    }
  }
  persistScheduler(ctx, sched);
  saveState(ctx.state);

  outHeader(ctx, 'Queue');
  ctx.out(ui.bullet(describeQueue(sched, now)));
  for (const item of upcoming(sched, now, 10)) {
    ctx.out(`  ${item.runAt}  r/${item.subreddit}  ${ui.dim(ui.truncate(item.reason, 52))}`);
  }
  ctx.out('');
  ctx.out(ui.success(scheduled > 0 ? `Scheduled ${scheduled} draft(s).` : 'Nothing new to schedule.'));
  return 0;
}

function toStore(state: CliState): AnalyticsStore {
  const store = createStore();
  store.posts = state.posts;
  store.metrics = state.metrics as never;
  store.clicks = state.clicks;
  store.signups = state.signups;
  return store;
}

function fromStore(state: CliState, store: AnalyticsStore): void {
  state.posts = store.posts;
  state.metrics = store.metrics as never;
  state.clicks = store.clicks;
  state.signups = store.signups;
}

export async function cmdMetrics(_args: string[], ctx: CommandContext): Promise<number> {
  const client = redditClient(ctx);
  if (!client.authenticated) {
    ctx.out(ui.fail('Not connected to Reddit - cannot read metrics.'));
    return 1;
  }
  const store = toStore(ctx.state);
  let updated = 0;
  for (const post of store.posts) {
    try {
      const m = await client.getPostMetrics(post.redditId);
      recordMetrics(store, {
        postId: post.id,
        capturedAt: new Date().toISOString(),
        upvotes: m.upvotes,
        downvotes: m.downvotes,
        comments: m.numComments,
        score: m.score,
        upvoteRatio: m.upvoteRatio,
        impressions: 0,
        clicks: store.clicks.filter((c) => c.postId === post.id).length,
        signups: store.signups.filter((s) => s.postId === post.id).length,
        revenueCents: store.signups.filter((s) => s.postId === post.id).reduce((a, s) => a + (s.revenueCents ?? 0), 0),
      });
      if (m.removed) {
        post.postedAt = post.postedAt;
        ctx.out(ui.warn(`r/${post.subreddit} removed a post - cooldown active.`));
      }
      updated++;
    } catch (error) {
      ctx.out(ui.warn(`${post.subreddit}: ${(error as Error).message}`));
    }
  }
  fromStore(ctx.state, store);
  saveState(ctx.state);
  ctx.out(ui.success(`Updated ${updated}/${store.posts.length} posts.`));
  return 0;
}

export function cmdAnalyze(_args: string[], ctx: CommandContext): number {
  const store = toStore(ctx.state);
  const rows = computePerformance(store).sort((a, b) => b.engagement - a.engagement);
  const report = buildWeeklyReport(store, ctx.now ?? new Date());

  outHeader(ctx, `Performance · week of ${report.week}`);
  if (rows.length === 0) {
    ctx.out(ui.dim('  Nothing published yet. Post something and the numbers show up here.'));
    return 0;
  }

  const summary = summarize(store);
  ctx.out(ui.table(
    ['METRIC', 'VALUE'],
    [
      ['Posts', String(summary.postsPublished)],
      ['Upvotes', String(summary.totalUpvotes)],
      ['Comments', String(summary.totalComments)],
      ['Avg voice score', String(Math.round(summary.avgVoiceScore))],
      ['Tracked clicks', String(summary.totalClicks)],
      ['Signups', String(summary.totalSignups)],
      ['Revenue', `$${(summary.totalRevenueCents / 100).toFixed(2)}`],
    ],
  ));

  outHeader(ctx, 'Posts');
  ctx.out(ui.table(
    ['SUB', 'STYLE', 'UP', 'CMT', 'SIGNUPS', 'VOICE', 'TITLE'],
    rows.slice(0, 15).map((r) => [
      r.subreddit,
      STYLE_LABEL[r.style],
      String(r.upvotes),
      String(r.comments),
      String(r.signups),
      ui.score(r.voiceScore),
      ui.truncate(r.title, 38),
    ]),
  ));

  if (report.topSubreddit) {
    outHeader(ctx, 'What is working');
    ctx.out(ui.bullet(`Best subreddit: r/${report.topSubreddit.key} (${Math.round(report.topSubreddit.avgEngagement)} avg engagement over ${report.topSubreddit.posts} posts)`));
    if (report.topStyle) ctx.out(ui.bullet(`Best style here: ${STYLE_LABEL[report.topStyle.key]}`));
    ctx.out(ui.bullet(`Voice score vs engagement: r=${report.correlation.coefficient} - ${report.correlation.verdict}`));
    const learning = computeLearning(store);
    const winners = Object.entries(learning.winningStyleBySubreddit);
    if (winners.length > 0) {
      ctx.out(ui.bullet(`Learned style per subreddit: ${winners.map(([sub, style]) => `${sub}->${style}`).join(', ')}`));
    }
  }

  outHeader(ctx, 'Next week');
  for (const recommendation of report.recommendations) ctx.out(ui.bullet(recommendation));
  return 0;
}

/* ------------------------------------------------------------------ */
/* sub / templates / suggest                                            */
/* ------------------------------------------------------------------ */

export async function cmdSub(args: string[], ctx: CommandContext): Promise<number> {
  const name = args.find((a) => !a.startsWith('-'));

  if (name === 'match' || !name) {
    const draft = ctx.state.drafts.find((d) => d.status === 'review') ?? ctx.state.drafts[0];
    if (!draft) {
      ctx.out(ui.fail('No draft to match. Run `upvote draft` first.'));
      return 1;
    }
    outHeader(ctx, `Where to post: ${ui.truncate(draft.title, 60)}`);
    for (const s of draft.suggestedSubreddits) {
      const mark = s.compliant ? ui.green('ok') : ui.red('blocked');
      ctx.out(`  ${mark} r/${s.subreddit.padEnd(18)} fit ${String(Math.round(s.fit)).padStart(3)}  ${ui.dim(s.reasons.join(', '))}`);
      for (const v of s.violations) ctx.out(`        ${ui.red(v)}`);
      for (const c of s.compliance) ctx.out(`        ${ui.green(c)}`);
    }
    return 0;
  }

  // Inspect one subreddit: rules, activity, best hours.
  const client = redditClient(ctx);
  const sub = name.replace(/^\/?r\//, '');
  let profile = subredditProfiles(ctx).find((p) => p.name === sub);
  if (client.authenticated) {
    try {
      profile = await client.getSubredditProfile(sub);
      profile.activityByHourUtc = await client.sampleActivityByHour(sub);
      ctx.state.subredditProfiles[sub] = profile;
      saveState(ctx.state);
    } catch (error) {
      ctx.out(ui.warn(`Could not refresh from Reddit (${(error as Error).message}). Showing cached data.`));
    }
  }
  if (!profile) {
    ctx.out(ui.fail(`No data for r/${sub}. Run \`upvote connect reddit\` first.`));
    return 1;
  }

  outHeader(ctx, `r/${profile.name}`);
  ctx.out(ui.bullet(`${profile.subscribers?.toLocaleString() ?? '?'} subscribers · activity ${Math.round(profile.activity ?? 0)}/100`));
  ctx.out(ui.bullet(`links ${profile.allowLinks ? 'allowed' : 'banned'} · self-promo ${profile.allowSelfPromo ? 'allowed' : 'restricted'} · flair ${profile.requiresFlair ? 'required' : 'optional'}`));
  ctx.out(ui.bullet(`topics: ${profile.topics.join(', ') || 'unknown'}`));
  if (profile.rules.length > 0) {
    ctx.out('');
    ctx.out(ui.bold('  Parsed rules'));
    for (const rule of profile.rules) {
      const value = rule.value !== undefined ? ` (${rule.value})` : '';
      ctx.out(`    ${rule.severity === 'hard' ? ui.red('HARD') : ui.yellow('soft')} ${ui.dim(rule.description + value)}`);
    }
  }
  const slots = predictBestTimes(profile, { count: 3, now: ctx.now ?? new Date() });
  if (slots.length > 0) {
    ctx.out('');
    ctx.out(ui.bold('  Best times'));
    for (const slot of slots) {
      ctx.out(`    ${formatInUserTimezone(slot.at, ctx.config.timezoneOffsetMinutes)}  ${ui.dim(slot.reason)}`);
    }
  }
  return 0;
}

export function cmdTemplates(args: string[], ctx: CommandContext): number {
  const id = args[0];
  if (!id) {
    outHeader(ctx, 'Distribution templates');
    for (const template of DISTRIBUTION_TEMPLATES) {
      ctx.out(ui.bold(`  ${template.id}`));
      ctx.out(ui.dim(`    ${template.name} - ${template.occasion}`));
      ctx.out(ui.dim(`    best for: ${template.categories.join(', ')}`));
      ctx.out(`    ${ui.dim('title: ' + template.titlePatterns[0])}`);
      ctx.out('');
    }
    ctx.out(ui.dim('  Use: upvote draft "..." --template=built_in_days'));
    return 0;
  }
  const template = DISTRIBUTION_TEMPLATES.find((t) => t.id === id);
  if (!template) {
    ctx.out(ui.fail(`Unknown template ${id}.`));
    return 1;
  }
  outHeader(ctx, template.name);
  ctx.out(ui.bullet(template.guidance));
  ctx.out(ui.bullet(`first comment: ${template.firstCommentGuidance}`));
  return 0;
}

export async function cmdSuggest(args: string[], ctx: CommandContext): Promise<number> {
  const profile = requireVoiceProfile(ctx);
  const postId = args[0];
  const post = ctx.state.posts.find((p) => p.id === postId || p.id.endsWith(postId ?? '\u0000'));
  if (!post) {
    ctx.out(ui.fail(`No published post with id ${postId}. Run \`upvote list posted\`.`));
    return 1;
  }
  const client = redditClient(ctx);
  if (!client.authenticated) {
    ctx.out(ui.fail('Not connected to Reddit.'));
    return 1;
  }
  const comments = await client.getComments(post.redditId, { limit: 20 });
  if (comments.length === 0) {
    ctx.out(ui.info('No comments yet.'));
    return 0;
  }

  outHeader(ctx, `Reply suggestions for r/${post.subreddit}`);
  for (const comment of comments.slice(0, 10)) {
    if (!comment.body.trim()) continue;
    const suggestion = await suggestReply(
      { author: comment.author, body: comment.body },
      { title: post.title, subreddit: post.subreddit },
      profile,
      { model: clientFromEnv() },
    );
    ctx.out('');
    ctx.out(`  u/${comment.author} ${ui.dim(`(${comment.score} points)`)}: ${ui.truncate(comment.body, 90)}`);
    ctx.out(`  ${ui.green('->')} ${suggestion.reply.replace(/\n+/g, ' ')}`);
    ctx.out(ui.dim(`     voice ${ui.score(suggestion.score)}`));
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* config / status                                                      */
/* ------------------------------------------------------------------ */

export function cmdConfig(args: string[], ctx: CommandContext): number {
  if (args.length === 0 || args[0] === 'show') {
    outHeader(ctx, 'Config');
    ctx.out(ui.bullet(`user: ${ctx.config.userId}`));
    ctx.out(ui.bullet(`plan: ${ctx.config.plan}`));
    ctx.out(ui.bullet(`github token: ${maskSecret(ctx.config.githubToken)}`));
    ctx.out(ui.bullet(`reddit client: ${maskSecret(ctx.config.reddit.clientId)}`));
    ctx.out(ui.bullet(`reddit account: ${ctx.config.reddit.accountName ? `u/${ctx.config.reddit.accountName}` : 'not connected'}`));
    ctx.out(ui.bullet(`product: ${ctx.config.product.name ?? '(none)'} ${ctx.config.product.url ?? ''}`));
    ctx.out(ui.bullet(`watching: ${ctx.config.watch.repos.map((r) => `${r.owner}/${r.repo}`).join(', ') || '(none)'}`));
    ctx.out(ui.bullet(`max ${ctx.config.guardrails.maxPostsPerDay}/day, ${ctx.config.guardrails.maxPostsPerSubredditPerWeek}/sub/week, approval ${ctx.config.guardrails.requireManualApproval ? 'required' : 'optional'}`));
    ctx.out(ui.dim(`  ${CONFIG_DIR}`));
    return 0;
  }

  const [section, ...rest] = args;
  for (const pair of rest) {
    const [key, ...valueParts] = pair.split('=');
    const value = valueParts.join('=');
    switch (section) {
      case 'reddit':
        if (key === '--client-id') ctx.config.reddit.clientId = value;
        if (key === '--client-secret') ctx.config.reddit.clientSecret = value;
        if (key === '--redirect-uri') ctx.config.reddit.redirectUri = value;
        break;
      case 'product':
        if (key === '--name') ctx.config.product.name = value;
        if (key === '--url') ctx.config.product.url = value;
        break;
      case 'guardrails':
        if (key === '--max-per-day') ctx.config.guardrails.maxPostsPerDay = Number(value);
        if (key === '--max-per-sub') ctx.config.guardrails.maxPostsPerSubredditPerWeek = Number(value);
        if (key === '--min-voice') ctx.config.guardrails.minAuthenticityScore = Number(value);
        if (key === '--auto') ctx.config.guardrails.requireManualApproval = false;
        if (key === '--manual') ctx.config.guardrails.requireManualApproval = true;
        if (key === '--block') ctx.config.guardrails.blocklist.push(value.replace(/^\/?r\//, ''));
        break;
      case 'watch':
        if (key === '--repo') {
          const [owner, repo] = value.replace(/^\/?/, '').split('/');
          if (owner && repo) ctx.config.watch.repos.push({ owner, repo });
        }
        break;
      default:
        break;
    }
  }
  ctx.config.guardrails = GuardrailConfigSchema.parse(ctx.config.guardrails);
  saveConfig(ctx.config);
  ctx.out(ui.success('Config saved.'));
  return 0;
}

export function cmdStatus(args: string[], ctx: CommandContext): number {
  const now = ctx.now ?? new Date();
  outHeader(ctx, 'Upvote status');
  const profile = ctx.state.voiceProfile;
  ctx.out(ui.bullet(profile ? `voice: v${profile.version} (${profile.sampleCount} samples) - ${describeVoice(profile)}` : ui.yellow('voice: not trained yet')));
  ctx.out(ui.bullet(`drafts: ${ctx.state.drafts.length} (${ctx.state.drafts.filter((d) => d.status === 'review').length} awaiting review)`));
  ctx.out(ui.bullet(`scheduled: ${ctx.state.drafts.filter((d) => d.status === 'scheduled').length}`));
  ctx.out(ui.bullet(`published: ${ctx.state.posts.length}`));
  ctx.out(ui.bullet(`engaged subreddits: ${ctx.state.engagedSubreddits.length}`));
  if (args.includes('--score') && profile) {
    ctx.out('');
    ctx.out(ui.bold('  Voice fingerprint'));
    for (const [key, value] of Object.entries(profile.vector)) {
      ctx.out(`    ${ui.dim(key.padEnd(24))} ${String(value).padStart(7)}`);
    }
  }
  const next = upcoming(schedulerState(ctx), now, 1)[0];
  if (next) ctx.out(ui.bullet(`next post: ${next.runAt} in r/${next.subreddit}`));
  return 0;
}

export function cmdGitHub(args: string[], ctx: CommandContext): number {
  const action = args[0] ?? 'watch';

  if (action === 'watch') {
    outHeader(ctx, 'Repository triggers');
    ctx.out(ui.dim('  Upvote drafts a post when a release ships, a shippable PR merges, or a bug closes.'));
    ctx.out(ui.dim('  Skip: docs-only changes, dependency bumps, lockfiles, CI edits, typo fixes.'));
    ctx.out('');
    ctx.out(`  ${ctx.config.watch.repos.length > 0 ? ctx.config.watch.repos.map((r) => `${r.owner}/${r.repo}`).join('\n  ') : ui.dim('(none - add with: upvote config watch --repo=owner/name)')}`);
    return 0;
  }

  if (action === 'sync') {
    // Reads a local git repo. Works with no GitHub token at all.
    const repoArg = args[1] ?? process.cwd();
    const { stdout, status } = spawnSync(
      'git',
      ['log', '--max-count=30', '--pretty=format:%H%x1f%s%x1f%b%x1e'],
      { cwd: repoArg, encoding: 'utf8' },
    );
    if (status !== 0) {
      ctx.out(ui.fail(`Could not read git log in ${repoArg}`));
      return 1;
    }
    const entries = stdout
      .split('\u001e')
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const [sha = '', subject = '', body = ''] = chunk.split('\u001f');
        return { sha, message: `${subject}\n${body}`.trim() };
      });

    const envelope = momentFromWebhook('push', {
      repository: { full_name: repoArg.split(/[\\/]/).slice(-2).join('/') },
      commits: entries.map((e) => ({ sha: e.sha, message: e.message })),
    });
    if (!envelope.moment) {
      ctx.out(ui.warn(`Nothing worth posting: ${envelope.detail}`));
      return 0;
    }
    const moment = envelope.moment;
    ctx.out(ui.success('Shipping moment detected from local git.'));
    ctx.out(ui.bullet(`what: ${moment.whatChanged}`));
    if (moment.lesson) ctx.out(ui.bullet(`lesson: ${moment.lesson}`));
    ctx.out('');
    ctx.out(ui.dim(`  Draft it with: upvote draft "${moment.whatChanged}"`));
    return 0;
  }

  ctx.out(ui.fail(`Unknown: upvote git ${action}`));
  return 1;
}

/* ------------------------------------------------------------------ */
/* onboarding                                                           */
/* ------------------------------------------------------------------ */

/** The 60-second onboarding wow moment: connect GitHub, see five drafts. */
export async function cmdOnboard(args: string[], ctx: CommandContext): Promise<number> {
  const text = args.filter((a) => !a.startsWith('--')).join(' ').trim()
    ?? 'shipped a rewrite of the ingest layer. the retry loop no longer caches its own failures. lesson: boring beats clever.';

  outHeader(ctx, 'Welcome to Upvote - ship code, we write the post');
  ctx.out(ui.dim('  Step 1/3  voice profile'));
  const rc = await cmdVoiceTrain(['--file=' + (args.find((a) => a.startsWith('--file='))?.split('=')[1] ?? 'samples.md')], ctx).catch(() => 1);
  if (!ctx.state.voiceProfile) {
    ctx.out(ui.info('No samples yet - drafting with a neutral voice so you can see the shape of it.'));
  }

  ctx.out('');
  ctx.out(ui.dim('  Step 2/3  first drafts'));
  const rc2 = await cmdDraft([text], ctx);
  ctx.out('');
  ctx.out(ui.dim('  Step 3/3  next'));
  ctx.out(ui.bullet('upvote connect reddit   - install the Reddit app so posting works'));
  ctx.out(ui.bullet('upvote config product --name=YourProduct --url=https://yourproduct.com'));
  ctx.out(ui.bullet('upvote approve <id>     - schedule it at the best hour'));
  ctx.out(ui.bullet('upvote post <id>        - publish immediately'));
  return rc2 === 0 || rc === 0 ? 0 : 1;
}

export { spawnSync };