/**
 * GitHub integration.
 *
 * Two halves:
 *  - `client.ts`   — thin REST client (releases, commits, PRs, issues, repos).
 *  - `triggers.ts` — turns webhook payloads into ShippingMoments, and decides
 *                    whether a change is worth telling anyone about.
 *
 * The filtering is the interesting part: most commits are noise, and a tool that
 * drafts a post for a typo fix trains the founder to ignore its queue.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ShippingMomentSchema,
  type MomentKind,
  type ShippingMoment,
} from '@upvote/core';

/* ------------------------------------------------------------------ */
/* Client                                                               */
/* ------------------------------------------------------------------ */

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  description?: string | null;
  stargazers_count?: number;
  language?: string | null;
  topics?: string[];
  private?: boolean;
  default_branch?: string;
  pushed_at?: string;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  html_url?: string;
  assets?: Array<{ name: string; download_count?: number }>;
}

export interface GitHubCommit {
  sha: string;
  html_url?: string;
  commit: { message: string; author?: { name?: string; date?: string; email?: string } };
  author?: { login?: string } | null;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body?: string | null;
  merged_at?: string | null;
  labels?: Array<{ name: string }>;
  user?: { login?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  html_url?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  closed_at?: string | null;
  labels?: Array<{ name: string }>;
  user?: { login?: string };
  state_reason?: string | null;
  html_url?: string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export class GitHubClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.userAgent = options.userAgent ?? 'upvote-cli';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.userAgent,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new GitHubApiError(
        `GitHub request failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`,
        response.status,
        body,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** The authenticated user, used to scope repo selection. */
  async authenticatedUser(): Promise<{ login: string; id: number }> {
    return this.request('/user');
  }

  async listRepos(): Promise<GitHubRepo[]> {
    const all: GitHubRepo[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.request<GitHubRepo[]>(
        `/user/repos?per_page=100&sort=pushed&page=${page}`,
      );
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request(`/repos/${owner}/${repo}`);
  }

  async listReleases(owner: string, repo: string, perPage = 10): Promise<GitHubRelease[]> {
    return this.request(`/repos/${owner}/${repo}/releases?per_page=${perPage}`);
  }

  async listCommits(
    owner: string,
    repo: string,
    options: { since?: string; perPage?: number; branch?: string } = {},
  ): Promise<GitHubCommit[]> {
    const params = new URLSearchParams({ per_page: String(options.perPage ?? 30) });
    if (options.since) params.set('since', options.since);
    if (options.branch) params.set('sha', options.branch);
    return this.request(`/repos/${owner}/${repo}/commits?${params.toString()}`);
  }

  async listPullRequests(
    owner: string,
    repo: string,
    options: { state?: 'open' | 'closed'; perPage?: number } = {},
  ): Promise<GitHubPullRequest[]> {
    const params = new URLSearchParams({
      per_page: String(options.perPage ?? 30),
      ...(options.state ? { state: options.state } : {}),
    });
    return this.request(`/repos/${owner}/${repo}/pulls?${params.toString()}`);
  }

  async listIssues(owner: string, repo: string, perPage = 30): Promise<GitHubIssue[]> {
    const items = await this.request<GitHubIssue[]>(
      `/repos/${owner}/${repo}/issues?state=all&per_page=${perPage}`,
    );
    // The issues endpoint also returns pull requests; filter them out.
    return items.filter((i) => !('pull_request' in i));
  }

  async getReadme(owner: string, repo: string): Promise<string> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/repos/${owner}/${repo}/readme`,
      { headers: { accept: 'application/vnd.github.raw', 'user-agent': this.userAgent } },
    );
    return response.ok ? await response.text() : '';
  }
}

/* ------------------------------------------------------------------ */
/* Webhook verification                                                 */
/* ------------------------------------------------------------------ */

/**
 * Verify GitHub's `X-Hub-Signature-256`. Constant-time compare, and a length
 * check first so timingSafeEqual cannot throw on mismatched buffers.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Filtering: is this worth a draft?                                    */
/* ------------------------------------------------------------------ */

export interface FilterConfig {
  /** PR label that means "this is postable". */
  shippableLabels: string[];
  /** Never trigger on these paths. */
  ignoredPaths: string[];
  /** Ignore commits that only touch docs/markdown. */
  skipDocsOnly: boolean;
  /** Ignore dependency bumps. */
  skipDependencyBumps: boolean;
  /** Ignore small changes (below this many files or lines). */
  minChangedFiles: number;
  minChangedLines: number;
  /** Conventional-commit types that are never interesting on their own. */
  boringTypes: string[];
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  shippableLabels: ['shippable', 'release', 'announce', 'showcase'],
  ignoredPaths: [
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'Cargo.lock',
    'go.sum', 'composer.lock', '.github/workflows/', '.github/dependabot.yml',
    'node_modules/', 'dist/', 'build/', 'coverage/', 'vendor/',
  ],
  skipDocsOnly: true,
  skipDependencyBumps: true,
  minChangedFiles: 1,
  minChangedLines: 3,
  boringTypes: ['chore', 'style', 'ci', 'test', 'build', 'refactor', 'docs', 'revert'],
};

export type FilterReason =
  | 'ok'
  | 'trivial'
  | 'docs_only'
  | 'dependency_bump'
  | 'ignored_path'
  | 'not_shippable'
  | 'too_small'
  | 'duplicate'
  | 'draft_or_prerelease';

export interface FilterResult {
  keep: boolean;
  reason: FilterReason;
  detail: string;
}

const DOC_EXTENSIONS = /\.(md|mdx|rst|txt|png|jpg|jpeg|gif|svg|ico|webp)$/i;
const DEPENDENCY_HINT = /^(?:deps?|chore|build|ci)(\(.*\))?!?:\s|\b(?:bump|upgrade|update) (?:dependencies|deps|packages)\b|\b(?:bumped|upgrade[d]?) [a-z@/-]+ to\b/i;

function normalizeCommitMessage(message: string): { type: string | null; subject: string; body: string } {
  const [first = '', ...rest] = message.split('\n');
  const match = /^(feat|fix|chore|docs|style|ci|test|perf|refactor|build|revert)(?:\(([^)]*)\))?(!)?:\s*(.*)$/i.exec(
    first,
  );
  if (!match) return { type: null, subject: first.trim(), body: rest.join('\n').trim() };
  return {
    type: (match[1] ?? '').toLowerCase(),
    subject: (match[4] ?? '').trim() || first.trim(),
    body: rest.join('\n').trim(),
  };
}

/** Decide whether a batch of commits is a shipping moment. */
export function filterCommits(
  commits: ReadonlyArray<{ message: string; files?: string[]; additions?: number; deletions?: number }>,
  config: Partial<FilterConfig> = {},
): FilterResult {
  const cfg = { ...DEFAULT_FILTER_CONFIG, ...config };
  if (commits.length === 0) return { keep: false, reason: 'trivial', detail: 'no commits' };

  const additions = commits.reduce((a, c) => a + (c.additions ?? 0), 0);
  const deletions = commits.reduce((a, c) => a + (c.deletions ?? 0), 0);
  const changedFiles = new Set(commits.flatMap((c) => c.files ?? [])).size || commits.length;

  const touchesIgnored = commits.some((c) =>
    (c.files ?? []).some((f) => cfg.ignoredPaths.some((p) => f.startsWith(p) || f.endsWith(p))),
  );
  if (touchesIgnored) {
    const allTouchIgnored = commits.every((c) =>
      (c.files ?? []).every((f) => cfg.ignoredPaths.some((p) => f.startsWith(p) || f.endsWith(p))),
    );
    if (allTouchIgnored) {
      return { keep: false, reason: 'ignored_path', detail: 'only lockfiles, CI or build output changed' };
    }
  }

  const messages = commits.map((c) => c.message);
  if (cfg.skipDependencyBumps && messages.some((m) => DEPENDENCY_HINT.test(m)) && additions + deletions < 50) {
    return { keep: false, reason: 'dependency_bump', detail: 'dependency bump' };
  }

  if (cfg.skipDocsOnly) {
    const allFiles = commits.flatMap((c) => c.files ?? []);
    if (allFiles.length > 0 && allFiles.every((f) => DOC_EXTENSIONS.test(f))) {
      return { keep: false, reason: 'docs_only', detail: 'only markdown and image files changed' };
    }
  }

  const types = messages.map((m) => normalizeCommitMessage(m).type);
  const allBoring = types.length > 0 && types.every((t) => t === null || cfg.boringTypes.includes(t));
  if (allBoring && additions + deletions < 30) {
    return {
      keep: false,
      reason: 'trivial',
      detail: `only ${types.join('/') ?? 'unconventional'} commits and a small diff`,
    };
  }

  if (changedFiles < cfg.minChangedFiles || additions + deletions < cfg.minChangedLines) {
    return {
      keep: false,
      reason: 'too_small',
      detail: `${changedFiles} file(s), ${additions + deletions} line(s)`,
    };
  }

  return {
    keep: true,
    reason: 'ok',
    detail: `${commits.length} commit(s), ${changedFiles} file(s), +${additions}/-${deletions}`,
  };
}

/** Does this PR carry a label that means the founder considers it postable? */
export function isShippablePR(
  pr: { labels?: Array<{ name: string }>; merged_at?: string | null },
  config: Partial<FilterConfig> = {},
): boolean {
  const cfg = { ...DEFAULT_FILTER_CONFIG, ...config };
  if (!pr.merged_at) return false;
  const labels = (pr.labels ?? []).map((l) => l.name.toLowerCase());
  return cfg.shippableLabels.some((wanted) => labels.includes(wanted.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/* Payload -> ShippingMoment                                            */
/* ------------------------------------------------------------------ */

const CommitishSchema = z.object({
  sha: z.string().optional(),
  id: z.string().optional(),
  message: z.string(),
  html_url: z.string().url().optional(),
  added: z.array(z.string()).optional(),
  modified: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  added_lines: z.number().optional(),
  deleted_lines: z.number().optional(),
  author: z
    .object({ name: z.string().optional(), username: z.string().optional(), email: z.string().optional() })
    .optional(),
  timestamp: z.string().optional(),
});

export type CommitishPayload = z.infer<typeof CommitishSchema>;

export type WebhookEvent =
  | 'push'
  | 'release'
  | 'pull_request'
  | 'issues'
  | 'commit_comment'
  | 'check_run'
  | 'unknown';

export interface WebhookEnvelope {
  event: WebhookEvent;
  moment: ShippingMoment | null;
  /** Why no moment was produced. */
  skipped?: FilterReason;
  detail?: string;
}

/** Map an `X-GitHub-Event` header to our trigger vocabulary. */
export function mapEvent(header: string | null | undefined): WebhookEvent {
  const value = (header ?? '').toLowerCase();
  if (value === 'push') return 'push';
  if (value === 'release') return 'release';
  if (value === 'pull_request') return 'pull_request';
  if (value === 'issues') return 'issues';
  if (value === 'commit_comment' || value === 'issue_comment') return 'commit_comment';
  if (value === 'check_run' || value === 'check_suite') return 'check_run';
  return 'unknown';
}

/** Infer technology tags from file paths and free text. */
export function inferTags(text: string, files: readonly string[] = []): string[] {
  const haystack = `${text}\n${files.join('\n')}`.toLowerCase();
  const tags = new Set<string>();
  const rules: Array<[RegExp, string]> = [
    [/\.(ts|tsx)$/, 'typescript'],
    [/\.tsx?$/, 'javascript'],
    [/\.py$/, 'python'],
    [/\.rs$/, 'rust'],
    [/\.go$/, 'go'],
    [/\.rb$/, 'ruby'],
    [/\.java$/, 'java'],
    [/\.swift$/, 'swift'],
    [/\.kt$/, 'kotlin'],
    [/\.php$/, 'php'],
    [/dockerfile|docker-compose|\.ya?ml/, 'docker'],
    [/next\.config|nextjs|next\.js/, 'nextjs'],
    [/tailwind/, 'tailwind'],
    [/postgres|postgresq|\.sql$/, 'postgres'],
    [/mongo/, 'mongodb'],
    [/redis/, 'redis'],
    [/react/, 'react'],
    [/vue/, 'vue'],
    [/svelte/, 'svelte'],
    [/vite|webpack|esbuild/, 'bundler'],
    [/openai|anthropic|gpt-|claude|llm|embedding|rag/, 'ai'],
    [/kubernetes|\bk8s\b/, 'kubernetes'],
    [/terraform|pulumi/, 'terraform'],
    [/aws|lambda|cloudfront|s3/, 'aws'],
    [/stripe|paddle|billing|subscription/, 'billing'],
  ];
  for (const [pattern, tag] of rules) if (pattern.test(haystack)) tags.add(tag);
  return [...tags];
}

function momentBase(input: {
  kind: MomentKind;
  id: string;
  title: string;
  body: string;
  whatChanged: string;
  lesson: string;
  tags: string[];
  files: string[];
  repo: string;
  url?: string;
  author?: string;
  occurredAt?: string;
  stars?: number;
  commitCount?: number;
  commitSha?: string;
}): ShippingMoment {
  const cleaned = ShippingMomentSchema.parse({
    id: input.id,
    kind: input.kind,
    title: input.title,
    body: input.body,
    whatChanged: input.whatChanged,
    lesson: input.lesson,
    tags: input.tags,
    source: {
      repo: input.repo,
      ...(input.url ? { url: input.url } : {}),
      ...(input.author ? { author: input.author } : {}),
      ...(input.stars !== undefined ? { stars: input.stars } : {}),
      ...(input.commitCount !== undefined ? { commitCount: input.commitCount } : {}),
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    },
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
  return cleaned;
}

/**
 * Turn any GitHub webhook payload into a ShippingMoment (or an explanation of
 * why there isn't one). This is the only entry point the webhook route uses.
 */
export function momentFromWebhook(
  event: WebhookEvent,
  payload: Record<string, unknown>,
  config: Partial<FilterConfig> = {},
): WebhookEnvelope {
  const repository = (payload.repository ?? {}) as { full_name?: string; stargazers_count?: number };
  const repo = repository.full_name ?? 'unknown/repo';
  const stars = repository.stargazers_count;

  switch (event) {
    case 'push': {
      const commits = z.array(CommitishSchema).safeParse(payload.commits);
      if (!commits.success) return { event, moment: null, skipped: 'trivial', detail: 'no commits in payload' };
      const parsed = commits.data;
      if (parsed.length === 0) {
        return { event, moment: null, skipped: 'trivial', detail: 'empty push' };
      }
      const files = parsed.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
      const filter = filterCommits(
        parsed.map((c) => ({
          message: c.message,
          files: [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])],
          additions: c.added_lines ?? 0,
          deletions: c.deleted_lines ?? 0,
        })),
        config,
      );
      if (!filter.keep) return { event, moment: null, skipped: filter.reason, detail: filter.detail };

      const subjects = parsed.map((c) => normalizeCommitMessage(c.message).subject).filter(Boolean);
      const head = normalizeCommitMessage(parsed[parsed.length - 1]!.message);
      const bodyText = parsed.map((c) => normalizeCommitMessage(c.message).body).filter(Boolean).join('\n');
      const lesson = firstLessonLine(bodyText);
      const totalAdded = parsed.reduce((a, c) => a + (c.added_lines ?? 0), 0);
      const totalDeleted = parsed.reduce((a, c) => a + (c.deleted_lines ?? 0), 0);

      return {
        event,
        moment: momentBase({
          kind: 'commit',
          id: `push_${repo.replace('/', '_')}_${String(parsed[parsed.length - 1]!.sha ?? Date.now()).slice(0, 8)}`,
          title: subjects[0] ?? head.subject,
          body: bodyText || subjects.join('\n'),
          whatChanged:
            subjects.length === 1
              ? subjects[0]!
              : `${subjects.length} commits: ${subjects.slice(0, 3).join('; ')}`,
          lesson,
          tags: inferTags(`${subjects.join(' ')} ${bodyText}`, files),
          files,
          repo,
          ...(parsed[parsed.length - 1]!.html_url ? { url: parsed[parsed.length - 1]!.html_url! } : {}),
          ...(parsed[0]!.author?.username || parsed[0]!.author?.name
            ? { author: parsed[0]!.author?.username ?? parsed[0]!.author?.name ?? 'unknown' }
            : {}),
          ...(parsed[0]!.timestamp ? { occurredAt: parsed[0]!.timestamp! } : {}),
          ...(stars !== undefined ? { stars } : {}),
          commitCount: parsed.length,
          ...(parsed[parsed.length - 1]!.sha ? { commitSha: parsed[parsed.length - 1]!.sha! } : {}),
        }),
        detail: `${totalAdded} added / ${totalDeleted} deleted across ${new Set(files).size} files`,
      };
    }

    case 'release': {
      const action = String(payload.action ?? '');
      const release = (payload.release ?? {}) as GitHubRelease;
      if (!release.tag_name) return { event, moment: null, skipped: 'trivial', detail: 'no tag' };
      if (action === 'deleted') {
        return { event, moment: null, skipped: 'trivial', detail: 'release deleted' };
      }
      if (action !== 'published' && action !== 'released') {
        return { event, moment: null, skipped: 'draft_or_prerelease', detail: `release ${action}` };
      }
      const body = (release.body ?? '').trim();
      const files: string[] = [];
      const subject = release.name?.trim() || release.tag_name;
      return {
        event,
        moment: momentBase({
          kind: 'release',
          id: `release_${repo.replace('/', '_')}_${release.tag_name.replace(/[^\w.-]/g, '_')}`,
          title: subject,
          body,
          whatChanged: body || `shipped ${release.tag_name}`,
          lesson: firstLessonLine(body),
          tags: inferTags(`${subject}\n${body}`, files),
          files,
          repo,
          ...(release.html_url ? { url: release.html_url } : {}),
          ...(release.published_at ? { occurredAt: release.published_at } : {}),
          ...(stars !== undefined ? { stars } : {}),
        }),
        detail: release.prerelease ? 'prerelease' : 'published release',
      };
    }

    case 'pull_request': {
      const action = String(payload.action ?? '');
      if (action !== 'closed') {
        return { event, moment: null, skipped: 'trivial', detail: `pull_request ${action}` };
      }
      const pr = (payload.pull_request ?? {}) as GitHubPullRequest;
      if (!isShippablePR({ labels: pr.labels, merged_at: pr.merged_at ?? undefined }, config)) {
        return {
          event,
          moment: null,
          skipped: 'not_shippable',
          detail: pr.merged_at ? 'merged without a shippable label' : 'closed unmerged',
        };
      }
      const body = (pr.body ?? '').trim();
      return {
        event,
        moment: momentBase({
          kind: 'pr_merged',
          id: `pr_${repo.replace('/', '_')}_${pr.number}`,
          title: pr.title,
          body,
          whatChanged: body || `merged ${pr.title}`,
          lesson: firstLessonLine(body),
          tags: inferTags(`${pr.title}\n${body}`, []),
          files: [],
          repo,
          ...(pr.html_url ? { url: pr.html_url } : {}),
          ...(pr.user?.login ? { author: pr.user.login } : {}),
          ...(pr.merged_at ? { occurredAt: pr.merged_at } : {}),
          ...(stars !== undefined ? { stars } : {}),
          commitCount: pr.changed_files,
        }),
        detail: `PR #${pr.number} merged with a shippable label`,
      };
    }

    case 'issues': {
      const action = String(payload.action ?? '');
      if (action !== 'closed') {
        return { event, moment: null, skipped: 'trivial', detail: `issues ${action}` };
      }
      const issue = (payload.issue ?? {}) as GitHubIssue;
      const body = (issue.body ?? '').trim();
      const isBug = (issue.labels ?? []).some((l) => /bug|defect/i.test(l.name));
      return {
        event,
        moment: momentBase({
          kind: 'issue_closed',
          id: `issue_${repo.replace('/', '_')}_${issue.number}`,
          title: issue.title,
          body,
          whatChanged: isBug ? `fixed: ${issue.title}` : `closed: ${issue.title}`,
          lesson: firstLessonLine(body),
          tags: inferTags(`${issue.title}\n${body}`, []),
          files: [],
          repo,
          ...(issue.html_url ? { url: issue.html_url } : {}),
          ...(issue.user?.login ? { author: issue.user.login } : {}),
          ...(issue.closed_at ? { occurredAt: issue.closed_at } : {}),
          ...(stars !== undefined ? { stars } : {}),
        }),
        detail: isBug ? 'bug closed - good "what I learned" material' : 'issue closed',
      };
    }

    case 'check_run':
      return {
        event,
        moment: null,
        skipped: 'trivial',
        detail: 'check runs are CI noise; connect a release or a shippable PR instead',
      };

    case 'commit_comment':
    case 'unknown':
    default:
      return { event, moment: null, skipped: 'trivial', detail: `no trigger for ${event}` };
  }
}

/** Pull the most quotable line out of release notes or a PR body. */
export function firstLessonLine(text: string): string {
  if (!text) return '';
  const markers = /^(?:lesson|takeaways?|learned|turns out|tl;dr|note)\b\s*:?\s*/i;
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim().replace(/^[-*>]\s*/, '');
    if (markers.test(line)) return line.replace(markers, '').trim().slice(0, 300);
  }
  // No explicit marker: use the first substantial line as a starting point.
  const candidate = text
    .split(/\n+/)
    .map((l) => l.trim())
    .find((l) => l.replace(/[#*`>]/g, '').length > 40);
  return (candidate ?? '').replace(/^[#*`>\s]+/, '').slice(0, 300);
}

/** Convenience for the CLI: build a moment from local `git log` output. */
export function momentFromLocalCommits(
  repoName: string,
  commits: ReadonlyArray<{ sha: string; message: string; files?: string[]; additions?: number; deletions?: number }>,
  config: Partial<FilterConfig> = {},
): ShippingMoment | null {
  const envelope = momentFromWebhook(
    'push',
    {
      repository: { full_name: repoName },
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.message,
        ...(c.files ? { modified: c.files } : {}),
        ...(c.additions !== undefined ? { added_lines: c.additions } : {}),
        ...(c.deletions !== undefined ? { deleted_lines: c.deletions } : {}),
      })),
    },
    config,
  );
  return envelope.moment;
}