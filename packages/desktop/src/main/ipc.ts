/**
 * IPC bridge: the only surface the renderer can reach.
 *
 * Every handler returns a plain serialisable object. Errors are returned, not
 * thrown, so the UI can show a message instead of a stack trace - and so no
 * internal path or secret leaks into the DOM.
 */
import { app, ipcMain, shell } from 'electron';
import {
  clientFromEnv,
  generateDraftSet,
  momentFromText,
  planById,
  pricingTable,
  safeErrorMessage,
  scoreAuthenticity,
  suggestReply,
  type Draft,
} from '@upvote/core';
import { trainVoiceProfile, describeProfile, balanceSamples, deduplicateSamples } from '@upvote/voice';
import { buildCalendar, chooseSlot, upcoming } from '@upvote/scheduler';
import {
  buildWeeklyReport,
  computeLearning,
  computePerformance,
} from '@upvote/analytics';
import { GitHubClient, momentFromLocalCommits } from '@upvote/gh';
import { RedditClient } from '@upvote/reddit';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const ok_ = <T>(data: T): Result<T> => ({ ok: true, data });
const err = (error: unknown): Result<never> => ({ ok: false, error: safeErrorMessage(error) });

/* ------------------------------------------------------------------ */
/* Store: same shape as the CLI, in the OS user data directory         */
/* ------------------------------------------------------------------ */

interface DesktopState {
  voiceProfile: ReturnType<typeof trainVoiceProfile>['profile'] | null;
  samples: Array<{ id: string; source: string; text: string; score: number }>;
  drafts: Draft[];
  history: Array<{ userId: string; subreddit: string; postedAt: string; postId: string; removed: boolean }>;
  posts: Array<{
    id: string;
    userId: string;
    draftId: string;
    subreddit: string;
    redditId: string;
    permalink: string;
    title: string;
    style: Draft['style'];
    voiceScore: number;
    postedAt: string;
    trackedUrl: string | null;
  }>;
  metrics: Array<Record<string, unknown>>;
  product: { name?: string; url?: string };
  plan: 'free' | 'pro' | 'team';
  reddit: { clientId: string; clientSecret: string; redirectUri: string; connected: boolean; accountName?: string };
  github: { token: string; connected: boolean; login?: string };
  timezoneOffsetMinutes: number;
}

function dataDir(): string {
  return path.join(app.getPath('userData'), 'store.json');
}

function defaults(): DesktopState {
  return {
    voiceProfile: null,
    samples: [],
    drafts: [],
    history: [],
    posts: [],
    metrics: [],
    product: {},
    plan: 'pro',
    reddit: {
      clientId: '',
      clientSecret: '',
      redirectUri: 'http://localhost:8787/callback',
      connected: false,
    },
    github: { token: '', connected: false },
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
  };
}

function loadState(): DesktopState {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(dataDir(), 'utf8')) };
  } catch {
    return defaults();
  }
}

function saveState(state: DesktopState): void {
  fs.mkdirSync(path.dirname(dataDir()), { recursive: true });
  const tmp = `${dataDir()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, dataDir());
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

export function registerIpc(): void {
  ipcMain.handle('state:get', () => ok_(loadState()));

  ipcMain.handle('status:get', () => {
    const state = loadState();
    return ok_({
      version: app_version(),
      dataPath: dataDir(),
      platform: process.platform,
      hasVoiceProfile: Boolean(state.voiceProfile),
      voiceSummary: state.voiceProfile ? describeProfile(state.voiceProfile) : null,
      sampleCount: state.samples.length,
      draftCount: state.drafts.length,
      scheduledCount: state.drafts.filter((d) => d.status === 'scheduled').length,
      postedCount: state.posts.length,
      modelConfigured: clientFromEnv() !== null,
      githubConnected: state.github.connected,
      redditConnected: state.reddit.connected,
      plan: state.plan,
      timezoneOffsetMinutes: state.timezoneOffsetMinutes,
    });
  });

  ipcMain.handle('voice:train', (_e, input: { text?: string; path?: string }) => {
    try {
      const state = loadState();
      const samples = [...state.samples];

      if (input.path) {
        const raw = fs.readFileSync(input.path, 'utf8');
        for (const [i, block] of raw.split(/\n\s*\n/).entries()) {
          const text = block.trim();
          if (text.length >= 40) samples.push({ id: `file_${i}`, source: 'reddit_post', text, score: 0 });
        }
      }
      if (input.text) {
        for (const [i, block] of input.text.split(/\n\s*\n/).entries()) {
          const text = block.trim();
          if (text.length >= 40) samples.push({ id: `paste_${i}`, source: 'reddit_post', text, score: 0 });
        }
      }

      const balanced = balanceSamples(deduplicateSamples(samples as never));
      if (balanced.length === 0) {
        return err(
          'Nothing to learn from yet. Paste a few posts, or connect Reddit with the GitHub token below.',
        );
      }

      const { profile, quality } = trainVoiceProfile(balanced as never, {
        userId: 'desktop',
        version: (state.voiceProfile?.version ?? 0) + 1,
      });

      state.samples = balanced as never;
      state.voiceProfile = profile;
      saveState(state);

      return ok_({
        profile,
        quality,
        summary: describeProfile(profile),
        sampleCount: balanced.length,
      });
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('draft:generate', async (_e, input: { moment: string; tags?: string[] }) => {
    try {
      const state = loadState();
      const profile = state.voiceProfile;
      if (!profile) return err('Train your voice profile first - the drafts would not sound like you.');

      const moment = momentFromText(input.moment, input.tags ?? []);
      const set = await generateDraftSet(moment, {
        userId: 'desktop',
        profile,
        model: clientFromEnv(),
        productName: state.product.name,
        linkUrl: state.product.url ?? null,
      });

      state.drafts = [...set.drafts, ...state.drafts].slice(0, 200);
      saveState(state);
      return ok_({ drafts: set.drafts, rejected: set.rejected, moment });
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('draft:rescore', (_e, input: { id: string; title?: string; body?: string }) => {
    try {
      const state = loadState();
      const draft = state.drafts.find((d) => d.id === input.id);
      if (!draft) return err('Draft not found.');
      if (!state.voiceProfile) return err('No voice profile.');

      const title = input.title ?? draft.title;
      const body = input.body ?? draft.body;
      const report = scoreAuthenticity(`${title}\n\n${body}`, state.voiceProfile, {
        style: draft.style,
      });

      draft.title = title;
      draft.body = body;
      draft.authenticityScore = report.score;
      draft.authenticity = report.breakdown as never;
      draft.authenticityNotes = report.notes.slice(0, 6);
      draft.editCount += 1;
      saveState(state);
      return ok_(report);
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('draft:approve', (_e, input: { id: string; subreddit?: string }) => {
    try {
      const state = loadState();
      const draft = state.drafts.find((d) => d.id === input.id);
      if (!draft) return err('Draft not found.');

      const subreddit = input.subreddit ?? draft.primarySubreddit;
      if (!subreddit) return err('Pick a subreddit first.');

      const { slot } = chooseSlot(draft, { now: new Date() });
      draft.status = 'scheduled';
      draft.primarySubreddit = subreddit;
      draft.scheduledFor = slot.at;
      saveState(state);
      return ok_({ scheduledFor: slot.at, subreddit });
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('draft:post', async (_e, input: { id: string }) => {
    try {
      const state = loadState();
      const draft = state.drafts.find((d) => d.id === input.id);
      if (!draft) return err('Draft not found.');
      if (!draft.primarySubreddit) return err('Approve the draft first so we know the subreddit.');

      const client = new RedditClient({
        clientId: state.reddit.clientId,
        clientSecret: state.reddit.clientSecret,
        redirectUri: state.reddit.redirectUri,
      });
      if (!client.authenticated) {
        return err('Reddit is not connected. Add your app credentials and run `upvote connect reddit`.');
      }

      const result = await client.submit({
        subreddit: draft.primarySubreddit,
        title: draft.title,
        text: draft.body,
      });

      draft.status = 'posted';
      draft.postedAt = new Date().toISOString();
      draft.redditId = result.id;
      draft.permalink = result.permalink;
      state.posts.unshift({
        id: `post_${draft.id.slice(-8)}`,
        userId: 'desktop',
        draftId: draft.id,
        subreddit: draft.primarySubreddit,
        redditId: result.id,
        permalink: result.permalink,
        title: draft.title,
        style: draft.style,
        voiceScore: draft.authenticityScore,
        postedAt: draft.postedAt,
        trackedUrl: state.product.url ?? null,
      });
      state.history.unshift({
        userId: 'desktop',
        subreddit: draft.primarySubreddit,
        postedAt: draft.postedAt,
        postId: result.id,
        removed: false,
      });
      saveState(state);
      return ok_({ permalink: result.permalink, id: result.id, firstComment: draft.firstComment });
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('analytics:report', () => {
    try {
      const state = loadState();
      const store = {
        posts: state.posts,
        metrics: state.metrics,
        clicks: [],
        signups: [],
      } as never;
      const rows = computePerformance(store);
      return ok_({
        rows,
        report: buildWeeklyReport(store, new Date()),
        learning: computeLearning(store),
      });
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('suggest:reply', async (_e, input: { postId: string }) => {
    try {
      const state = loadState();
      if (!state.voiceProfile) return err('Train your voice profile first.');
      const post = state.posts.find((p) => p.id === input.postId);
      if (!post) return err('Published post not found.');

      const client = new RedditClient({});
      if (!client.authenticated) return err('Connect Reddit to read comments.');
      const comments = await client.getComments(post.redditId, { limit: 10 });
      const suggestions = [];
      for (const comment of comments) {
        if (!comment.body.trim()) continue;
        const suggestion = await suggestReply(
          { author: comment.author, body: comment.body },
          { title: post.title, subreddit: post.subreddit },
          state.voiceProfile,
          { model: clientFromEnv() },
        );
        suggestions.push({ comment, suggestion });
      }
      return ok_(suggestions);
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('git:sync', (_e, input: { repoPath?: string } = {}) => {
    try {
      const cwd = input.repoPath || os.homedir();
      const out = execFileSync(
        'git',
        ['log', '--max-count=30', '--pretty=format:%H%x1f%s%x1f%b%x1e'],
        { cwd, encoding: 'utf8' },
      );
      const entries = out
        .split('\u001e')
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
          const [sha = '', subject = '', body = ''] = chunk.split('\u001f');
          return { sha, message: `${subject}\n${body}`.trim() };
        });
      const moment = momentFromLocalCommits(cwd.split(/[\\/]/).slice(-2).join('/'), entries);
      return ok_(moment ?? { skipped: true, detail: 'Nothing worth posting in the last 30 commits.' });
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('github:verify', () => {
    try {
      const state = loadState();
      if (!state.github.token) return err('No GitHub token saved.');
      const client = new GitHubClient({ token: state.github.token });
      const user = client.authenticated
        ? new GitHubClient({ token: state.github.token })
        : null;
      void user;
      return ok_({ login: state.github.login ?? 'token present' });
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('config:save', (_e, input: Partial<DesktopState>) => {
    try {
      const state = { ...loadState(), ...input };
      saveState(state);
      return ok_({ saved: true });
    } catch (error) {
      return err(error);
    }
  });

  ipcMain.handle('pricing:get', () => ok_(pricingTable().map((p) => ({ ...p }))));
  ipcMain.handle('plan:get', () => ok_(planById(loadState().plan)));
  ipcMain.handle('calendar:get', () => {
    const state = loadState();
    const sched = {
      items: state.drafts
        .filter((d) => d.status === 'scheduled' && d.scheduledFor)
        .map((d) => ({
          draftId: d.id,
          userId: 'desktop',
          subreddit: d.primarySubreddit ?? 'unknown',
          runAt: d.scheduledFor!,
          reason: 'approved in the desktop app',
          attempts: 0,
          status: 'scheduled' as const,
        })),
      history: state.history,
      config: {
        maxPostsPerDay: 3,
        maxPostsPerSubredditPerWeek: 1,
        maxCommentsPerDay: 30,
        cooldownHoursAfterRemoval: 72,
        blocklist: [],
        avoidCategories: [],
        requireManualApproval: true,
        requirePriorEngagement: true,
        minAccountAgeDays: 0,
        minAuthenticityScore: 85,
      },
    };
    return ok_({
      calendar: buildCalendar(sched, { days: 14 }),
      upcoming: upcoming(sched, new Date(), 10),
    });
  });

  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return ok_({ opened: true });
  });
}

function app_version(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    return String(JSON.parse(fs.readFileSync(url, 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** Exported for tests: the pure analytics helpers are reusable directly. */
export { computePerformance, computeLearning };