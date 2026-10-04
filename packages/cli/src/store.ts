/**
 * Local config + state store for the CLI.
 *
 * Everything lives in ~/.upvote/ as JSON so the CLI works with zero setup,
 * zero daemon and zero database. The dashboard reads the same shape over HTTP.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Draft,
  GuardrailConfig,
  PlanId,
  PostingHistoryEntry,
  VoiceProfile,
  VoiceSample,
} from '@upvote/core';
import type { RedditTokens } from '@upvote/reddit';

export const CONFIG_DIR = process.env.UPVOTE_HOME ?? path.join(os.homedir(), '.upvote');

export interface CliConfig {
  userId: string;
  githubToken?: string;
  reddit: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    tokens: RedditTokens | null;
    accountName?: string;
    accountAgeDays?: number;
    accountKarma?: number;
  };
  product: {
    name?: string;
    url?: string;
  };
  watch: {
    repos: Array<{ owner: string; repo: string; branch?: string; shippableLabels?: string[] }>;
  };
  guardrails: GuardrailConfig;
  plan: PlanId;
  onboardingComplete: boolean;
  timezoneOffsetMinutes: number;
}

export interface CliState {
  voiceProfile: VoiceProfile | null;
  samples: VoiceSample[];
  drafts: Draft[];
  subredditProfiles: Record<string, unknown>;
  engagedSubreddits: string[];
  history: PostingHistoryEntry[];
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
  clicks: Array<{ postId: string; at: string; referer?: string }>;
  signups: Array<{ postId: string; at: string; revenueCents?: number }>;
  subreddits: Record<string, unknown>;
}

export function defaultConfig(): CliConfig {
  return {
    userId: `u_${os.userInfo().username}`,
    reddit: {
      clientId: process.env.REDDIT_CLIENT_ID ?? '',
      clientSecret: process.env.REDDIT_CLIENT_SECRET ?? '',
      redirectUri: process.env.REDDIT_REDIRECT_URI ?? 'http://localhost:8787/callback',
      tokens: null,
    },
    product: {},
    watch: { repos: [] },
    guardrails: {
      maxPostsPerDay: 3,
      maxPostsPerSubredditPerWeek: 1,
      maxCommentsPerDay: 30,
      cooldownHoursAfterRemoval: 72,
      blocklist: [],
      avoidCategories: ['nsfw', 'politics', 'military', 'animals_only'],
      requireManualApproval: true,
      requirePriorEngagement: true,
      minAccountAgeDays: 0,
      minAuthenticityScore: 85,
    },
    plan: 'pro',
    onboardingComplete: false,
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
  };
}

export function defaultState(): CliState {
  return {
    voiceProfile: null,
    samples: [],
    drafts: [],
    subredditProfiles: {},
    engagedSubreddits: [],
    history: [],
    posts: [],
    metrics: [],
    clicks: [],
    signups: [],
    subreddits: {},
  };
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: a half-written config is worse than none at all. */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function configPath(): string {
  return path.join(CONFIG_DIR, 'config.json');
}

export function statePath(): string {
  return path.join(CONFIG_DIR, 'state.json');
}

export function loadConfig(): CliConfig {
  const defaults = defaultConfig();
  const stored = readJson<Partial<CliConfig>>(configPath(), {});
  return {
    ...defaults,
    ...stored,
    reddit: { ...defaults.reddit, ...(stored.reddit ?? {}) },
    product: { ...defaults.product, ...(stored.product ?? {}) },
    watch: { ...defaults.watch, ...(stored.watch ?? {}) },
    guardrails: { ...defaults.guardrails, ...(stored.guardrails ?? {}) },
  };
}

export function saveConfig(config: CliConfig): void {
  writeJson(configPath(), config);
}

export function loadState(): CliState {
  const defaults = defaultState();
  const stored = readJson<Partial<CliState>>(statePath(), {});
  return { ...defaults, ...stored };
}

export function saveState(state: CliState): void {
  writeJson(statePath(), state);
}

export function ensureDir(): string {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return CONFIG_DIR;
}

/** Mask a secret for display: keep enough to recognise it, never enough to use it. */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '(not set)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}