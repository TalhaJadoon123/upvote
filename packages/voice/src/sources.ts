/**
 * Source adapters: turn raw API payloads from each platform into VoiceSamples.
 *
 * These are pure transforms so ingestion is testable without any network calls.
 */
import type { VoiceSample } from '@upvote/core';
import { unique } from '@upvote/core';

/* ------------------------------------------------------------------ */
/* Reddit                                                               */
/* ------------------------------------------------------------------ */

export interface RedditListingItem {
  kind?: string;
  data: {
    id: string;
    title?: string;
    body?: string;
    selftext?: string;
    score?: number;
    created_utc?: number;
    permalink?: string;
    subreddit?: string;
  };
}

/** Reddit listing: mix of `t3` (posts) and `t1` (comments). */
export function samplesFromRedditListing(
  items: readonly RedditListingItem[],
): VoiceSample[] {
  const samples: VoiceSample[] = [];
  for (const item of items) {
    const data = item.data;
    const text = (data.selftext || data.body || data.title || '').trim();
    if (text.length < 20) continue;
    const isComment = item.kind === 't1' || (!data.title && Boolean(data.body));
    samples.push({
      id: `${data.id}`,
      source: isComment ? 'reddit_comment' : 'reddit_post',
      text: cleanRedditText(text),
      score: data.score ?? 0,
      createdAt: data.created_utc
        ? new Date(data.created_utc * 1000).toISOString()
        : undefined,
    });
  }
  return samples;
}

/**
 * Reddit bodies are full of u/ mentions, markdown links and edit notes.
 * Those artefacts distort style measurements, so they are stripped.
 */
export function cleanRedditText(text: string): string {
  return text
    .replace(/^edit:.*$/gim, '')
    .replace(/^>.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/r\/(\w+)/g, 'r/$1')
    .replace(/\bu\//g, 'u/')
    .replace(/^\s*\*\*(?:edit|update).*?:\*\*.*$/gim, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* GitHub                                                               */
/* ------------------------------------------------------------------ */

export interface GitHubCommit {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string } };
  author?: { login?: string } | null;
}

export interface GitHubRepo {
  full_name: string;
  description?: string | null;
  stargazers_count?: number;
}

export function samplesFromCommits(commits: readonly GitHubCommit[]): VoiceSample[] {
  return commits
    .map((commit) => ({
      id: commit.sha,
      // Conventional-commit subjects are formulaic; keep the body, drop the prefix.
      source: 'commit' as const,
      text: commit.commit.message
        .replace(/^(feat|fix|chore|docs|refactor|test|perf|build|ci)(\([^)]*\))?!?:\s*/im, '')
        .trim(),
      score: 0,
      createdAt: commit.commit.author?.date,
    }))
    .filter((s) => s.text.length >= 20);
}

export function samplesFromReadme(repo: GitHubRepo, readme: string): VoiceSample[] {
  const description = (repo.description ?? '').trim();
  const cleaned = readme
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .trim();
  const samples: VoiceSample[] = [];
  if (description.length >= 20) {
    samples.push({ id: `${repo.full_name}:desc`, source: 'readme', text: description, score: 0 });
  }
  if (cleaned.length >= 40) {
    samples.push({ id: `${repo.full_name}:readme`, source: 'readme', text: cleaned, score: 0 });
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* Twitter / blog                                                       */
/* ------------------------------------------------------------------ */

export interface Tweet {
  id_str: string;
  full_text: string;
  favorite_count?: number;
  retweet_count?: number;
  created_at?: string;
}

/** Tweets are single-line and abbreviation-heavy; keep them but never let them dominate. */
export function samplesFromTweets(tweets: readonly Tweet[]): VoiceSample[] {
  return tweets
    .filter((t) => t.full_text && t.full_text.trim().length >= 20)
    .map((tweet) => ({
      id: tweet.id_str,
      source: 'tweet' as const,
      text: tweet.full_text.replace(/https?:\/\/\S+/g, '').trim(),
      score: (tweet.favorite_count ?? 0) + (tweet.retweet_count ?? 0),
      createdAt: tweet.created_at,
    }));
}

export interface BlogPost {
  id: string;
  title: string;
  content: string;
  publishedAt?: string;
  wordCount?: number;
}

export function samplesFromBlogPosts(posts: readonly BlogPost[]): VoiceSample[] {
  return posts
    .map((post) => {
      const text = stripHtml(post.content);
      return {
        id: post.id,
        source: 'blog' as const,
        text: `${post.title}\n\n${text}`.trim(),
        score: 0,
        createdAt: post.publishedAt,
      };
    })
    .filter((s) => s.text.length >= 100);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Manual sample input (dashboard "add a sample" box)                  */
/* ------------------------------------------------------------------ */

export function sampleFromManualText(userId: string, text: string, index = 0): VoiceSample | null {
  const trimmed = text.trim();
  if (trimmed.length < 20) return null;
  return {
    id: `${userId}:manual:${index}:${Date.now()}`,
    source: 'reddit_post',
    text: trimmed,
    score: 0,
  };
}

/**
 * Cap per-source volume so a huge commit history cannot swamp the founder's
 * actual prose. Commit messages are useful for terseness but not for tone.
 */
export function balanceSamples(
  samples: readonly VoiceSample[],
  limits: Partial<Record<VoiceSample['source'], number>> = {
    commit: 80,
    readme: 15,
    tweet: 80,
    blog: 20,
    reddit_comment: 250,
    reddit_post: 100,
  },
): VoiceSample[] {
  const counts = new Map<string, number>();
  const kept: VoiceSample[] = [];
  // Highest-signal sources first so truncation never drops Reddit prose.
  const order: VoiceSample['source'][] = [
    'reddit_post',
    'reddit_comment',
    'blog',
    'tweet',
    'readme',
    'commit',
  ];
  const bySource = new Map<string, VoiceSample[]>();
  for (const sample of samples) {
    const list = bySource.get(sample.source) ?? [];
    list.push(sample);
    bySource.set(sample.source, list);
  }
  for (const source of order) {
    const list = bySource.get(source) ?? [];
    const limit = limits[source] ?? 50;
    // Keep the best-performing samples when we have to truncate.
    const sorted = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const sample of sorted.slice(0, limit)) {
      kept.push(sample);
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  void counts;
  return kept;
}

/** Drop near-duplicate samples so one thread does not dominate the profile. */
export function deduplicateSamples(
  samples: readonly VoiceSample[],
  similarityThreshold = 0.85,
): VoiceSample[] {
  const seen = new Set<string>();
  const out: VoiceSample[] = [];
  for (const sample of samples) {
    const fingerprint = sample.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 12).join(' ');
    if (fingerprint.length > 0 && seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(sample);
    void similarityThreshold;
  }
  return out;
}

/** Summary line for the onboarding screen. */
export function describeSources(samples: readonly VoiceSample[]): string {
  const counts: Record<string, number> = {};
  for (const sample of samples) counts[sample.source] = (counts[sample.source] ?? 0) + 1;
  return unique(
    Object.entries(counts).map(([source, n]) => `${n} ${source.replace(/_/g, ' ')}`),
  ).join(', ');
}