/**
 * Reddit API client.
 *
 * Hard rule: posts go out with the *founder's* OAuth token. Upvote never posts
 * from its own account, because a shared account is the fastest way to get every
 * user of this product shadowbanned at once.
 *
 * Implemented against the documented oauth.reddit.com endpoints with the
 * standard OAuth2 token flow (authorization code + refresh token).
 */
import { z } from 'zod';
import { profileFromRedditJson, type SubredditProfile } from '@upvote/core';

export const USER_AGENT = (version = '0.1.0') =>
  `node:upvote:v${version} (by /u/upvote_app) - Reddit growth engine`;

export const REDDIT_BASE = 'https://oauth.reddit.com';
export const REDDIT_AUTH_BASE = 'https://www.reddit.com';

export class RedditApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorType?: string,
  ) {
    super(message);
    this.name = 'RedditApiError';
  }
}

/* ------------------------------------------------------------------ */
/* Config                                                               */
/* ------------------------------------------------------------------ */

export interface RedditConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Scopes requested at install time. */
  scopes?: string[];
  /** 'script' apps have no user login. */
  appType?: 'script' | 'web';
}

export const DEFAULT_SCOPES = [
  'identity',
  'read',
  'submit',
  'subscribe',
  'history',
  'save',
  'edit',
  'vote',
];

export interface RedditTokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until access_token expires. */
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
  obtainedAt: string;
}

const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/* Posting                                                              */
/* ------------------------------------------------------------------ */

export interface SubmitInput {
  subreddit: string;
  title: string;
  /** Markdown text post. Mutually exclusive with `link`. */
  text?: string;
  link?: string;
  flairId?: string;
  /** 'snoovatar' keeps the founder's own avatar. */
  apiType?: 'json' | 'snoovatar';
  /** Reddit-specific: send replies straight to the inbox. */
  replyTo?: string;
  resubmit?: boolean;
}

export interface SubmitResult {
  json: { errors: unknown[]; data?: { id?: string; name?: string; url?: string } };
  id: string;
  permalink: string;
}

export interface PostMetricsSnapshot {
  id: string;
  score: number;
  upvotes: number;
  downvotes: number;
  numComments: number;
  upvoteRatio: number;
  removed: boolean;
  stickied: boolean;
  selfText: string;
  createdUtc: number;
}

export interface RedditCommentSnapshot {
  id: string;
  author: string;
  body: string;
  score: number;
  createdUtc: number;
}

/* ------------------------------------------------------------------ */
/* Client                                                               */
/* ------------------------------------------------------------------ */

export interface RedditClientOptions extends Partial<RedditConfig> {
  tokens?: RedditTokens | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Injectable clock so token refresh is testable. */
  now?: () => Date;
}

export class RedditClient {
  private config: Required<Pick<RedditConfig, 'clientId' | 'clientSecret' | 'redirectUri'>> & RedditConfig;
  private tokens: RedditTokens | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly now: () => Date;
  /** Coalesces concurrent refreshes so a burst of posts refreshes once. */
  private refreshInFlight: Promise<RedditTokens> | null = null;

  constructor(options: RedditClientOptions = {}) {
    this.config = {
      clientId: options.clientId ?? process.env.REDDIT_CLIENT_ID ?? '',
      clientSecret: options.clientSecret ?? process.env.REDDIT_CLIENT_SECRET ?? '',
      redirectUri: options.redirectUri ?? process.env.REDDIT_REDIRECT_URI ?? 'http://localhost:5173/api/reddit/callback',
      scopes: options.scopes ?? DEFAULT_SCOPES,
      appType: options.appType ?? 'web',
    };
    this.tokens = options.tokens ?? null;
    this.baseUrl = (options.baseUrl ?? REDDIT_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? USER_AGENT();
    this.now = options.now ?? (() => new Date());
  }

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  get authenticated(): boolean {
    return Boolean(this.tokens?.accessToken);
  }

  get currentTokens(): RedditTokens | null {
    return this.tokens;
  }

  /** Build the URL the founder opens to install the app. */
  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      state,
      redirect_uri: this.config.redirectUri,
      scope: (this.config.scopes ?? DEFAULT_SCOPES).join(' '),
      duration: 'permanent',
    });
    return `${REDDIT_AUTH_BASE}/api/v1/authorize?${params.toString()}`;
  }

  /** Exchange the `?code=` from the callback for tokens. */
  async exchangeCode(code: string): Promise<RedditTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
    });
    return this.requestTokens(body);
  }

  /** Installed apps use a username+password grant (only for `script` apps). */
  async passwordGrant(username: string, password: string): Promise<RedditTokens> {
    const body = new URLSearchParams({
      grant_type: 'password',
      username,
      password,
    });
    return this.requestTokens(body);
  }

  private async requestTokens(body: URLSearchParams): Promise<RedditTokens> {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new RedditApiError(
        'Reddit app credentials are not configured. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.',
        0,
        'config',
      );
    }
    const response = await this.fetchImpl(`${REDDIT_AUTH_BASE}/api/v1/access_token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': this.userAgent,
      },
      body,
    });
    if (!response.ok) {
      throw new RedditApiError(`Token request failed: ${response.status}`, response.status, 'auth');
    }
    const parsed = TokenResponseSchema.parse(await response.json());
    this.tokens = {
      accessToken: parsed.access_token,
      ...(parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}),
      ...(parsed.expires_in !== undefined ? { expiresIn: parsed.expires_in } : {}),
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      ...(parsed.token_type ? { tokenType: parsed.token_type } : {}),
      obtainedAt: this.now().toISOString(),
    };
    return this.tokens;
  }

  /** Refresh before expiry; Reddit issues hour-long access tokens. */
  async refreshTokens(): Promise<RedditTokens> {
    if (!this.tokens?.refreshToken) {
      throw new RedditApiError('No refresh token available; the founder must reinstall the app.', 0, 'auth');
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens!.refreshToken!,
      });
      try {
        return await this.requestTokens(body);
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private isExpired(): boolean {
    if (!this.tokens) return true;
    const expiresIn = this.tokens.expiresIn ?? 3600;
    const age = (this.now().getTime() - new Date(this.tokens.obtainedAt).getTime()) / 1000;
    return age >= expiresIn - 60;
  }

  private async ensureToken(): Promise<string> {
    if (!this.authenticated) {
      throw new RedditApiError('Not connected to Reddit. Run `upvote connect reddit` first.', 0, 'auth');
    }
    if (this.isExpired() && this.tokens?.refreshToken) return (await this.refreshTokens()).accessToken;
    return this.tokens!.accessToken;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.ensureToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': this.userAgent,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

    if (response.status === 401 && this.tokens?.refreshToken) {
      await this.refreshTokens();
      return this.api<T>(path, init);
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 60);
      throw new RedditApiError(
        `Rate limited by Reddit. Retry in ${retryAfter}s.`,
        429,
        'ratelimit',
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new RedditApiError(
        `Reddit request failed: ${response.status} ${response.statusText} ${text.slice(0, 300)}`,
        response.status,
        'api',
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /* ---------------------------------------------------------------- */
  /* Identity + voice ingestion                                        */
  /* ---------------------------------------------------------------- */

  /** Who am I? Used to prove the connection and to record account age. */
  async me(): Promise<{ id: string; name: string; createdUtc: number; verified: boolean }> {
    const json = await this.api<{ id: string; name: string; created_utc: number; verified: boolean }>(
      '/api/v1/me',
    );
    return { id: json.id, name: json.name, createdUtc: json.created_utc, verified: json.verified };
  }

  /**
   * The founder's own submissions and comments, newest first.
   * This is the raw material for the voice profile.
   */
  async getMyActivity(options: { limit?: number; after?: string; types?: ('posts' | 'comments')[] } = {}) {
    const limit = Math.min(options.limit ?? 100, 100);
    const types = options.types ?? ['posts', 'comments'];
    const params = new URLSearchParams({
      limit: String(limit),
      raw_json: '1',
      ...(options.after ? { after: options.after } : {}),
    });
    const json = await this.api<{ kind: string; data: { children: Array<{ kind: string; data: unknown }> } }>(
      `/api/v1/me/${types.join('_and_')}?${params.toString()}`,
    );
    return json.data.children;
  }

  /** Every subreddit the founder has posted in or commented on. */
  async listEngagedSubreddits(): Promise<string[]> {
    const posts = await this.api<Array<{ data: { subreddit?: string } }>>(
      '/user/subreddits/submitted.json?limit=100&raw_json=1',
    ).catch(() => []);
    const comments = await this.api<Array<{ data: { subreddit?: string } }>>(
      '/user/subreddits/commented.json?limit=100&raw_json=1',
    ).catch(() => []);
    const names = new Set<string>();
    for (const item of [...posts, ...comments]) {
      if (item?.data?.subreddit) names.add(item.data.subreddit);
    }
    return [...names];
  }

  /* ---------------------------------------------------------------- */
  /* Subreddit metadata                                                */
  /* ---------------------------------------------------------------- */

  async getSubredditProfile(subreddit: string): Promise<SubredditProfile> {
    const name = subreddit.replace(/^\/?(r\/)?/, '').trim();
    const [about, sidebar] = await Promise.all([
      this.api<{ data: Record<string, unknown> }>(`/r/${name}/about.json`),
      this.api<{ data: string | null }>(`/r/${name}/about/sidebar.json`).catch(() => ({ data: null })),
    ]);
    return profileFromRedditJson(
      name,
      about.data as Parameters<typeof profileFromRedditJson>[1],
      typeof sidebar.data === 'string' ? sidebar.data : '',
    );
  }

  /** Flair templates for a subreddit, needed to post with flair. */
  async getFlairs(subreddit: string): Promise<Array<{ id: string; text: string }>> {
    try {
      const json = await this.api<Array<{ id: string; text: string }>>(
        `/r/${subreddit.replace(/^\/?(r\/)?/, '')}/api/link_flair_v2.json`,
      );
      return json;
    } catch {
      return [];
    }
  }

  /**
   * Sample recent posts to learn a subreddit's activity curve by hour of day.
   * Reddit exposes no analytics, so this is measured from the top-of-hour feed.
   */
  async sampleActivityByHour(subreddit: string, pages = 2): Promise<number[]> {
    const buckets = new Array<number>(24).fill(0);
    for (let page = 1; page <= pages; page++) {
      const json = await this.api<{ data: { children: Array<{ data: { created_utc: number; score: number } }> } }>(
        `/r/${subreddit.replace(/^\/?(r\/)?/, '')}/top.json?t=month&limit=100&page=${page}&raw_json=1`,
      );
      for (const child of json.data.children) {
        const hour = new Date(child.data.created_utc * 1000).getUTCHours();
        // Upvotes are the better signal: a quiet hour can still hold a great post.
        buckets[hour] = (buckets[hour] ?? 0) + 1 + Math.log10(1 + Math.max(child.data.score, 0));
      }
    }
    return buckets;
  }

  /* ---------------------------------------------------------------- */
  /* Posting                                                           */
  /* ---------------------------------------------------------------- */

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const subreddit = input.subreddit.replace(/^\/?(r\/)?/, '');
    if (!input.text && !input.link) {
      throw new RedditApiError('A post needs either text or a link.', 0, 'input');
    }

    const body = new URLSearchParams({
      api_type: 'json',
      sr: subreddit,
      title: input.title,
      ...(input.text ? { text: input.text } : {}),
      ...(input.link ? { url: input.link } : {}),
      ...(input.flairId ? { flair_id: input.flairId } : {}),
      ...(input.resubmit !== undefined ? { resubmit: String(input.resubmit) } : {}),
      ...(input.replyTo ? { thing_id: input.replyTo } : {}),
      kind: input.link ? 'link' : 'self',
    });

    const token = await this.ensureToken();
    const response = await this.fetchImpl(`${this.baseUrl}/api/submit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': this.userAgent,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (response.status === 401 && this.tokens?.refreshToken) {
      await this.refreshTokens();
      return this.submit(input);
    }
    if (!response.ok) {
      throw new RedditApiError(
        `Submit failed: ${response.status} ${response.statusText}`,
        response.status,
        'submit',
      );
    }

    const json = (await response.json()) as SubmitResult['json'];
    const errors = json.errors ?? [];
    if (errors.length > 0) {
      throw new RedditApiError(
        `Reddit rejected the post: ${describeSubmitErrors(errors)}`,
        200,
        'submit_rejected',
      );
    }
    const id = json.data?.name ?? '';
    return {
      json,
      id,
      permalink: `https://www.reddit.com${json.data?.url ?? ''}`,
    };
  }

  async comment(parentId: string, text: string): Promise<{ id: string; permalink: string }> {
    const body = new URLSearchParams({ api_type: 'json', thing_id: parentId, text });
    const token = await this.ensureToken();
    const response = await this.fetchImpl(`${this.baseUrl}/api/comment`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': this.userAgent,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      throw new RedditApiError(`Comment failed: ${response.status}`, response.status, 'comment');
    }
    const json = (await response.json()) as SubmitResult['json'];
    const errors = json.errors ?? [];
    if (errors.length > 0) {
      throw new RedditApiError(`Reddit rejected the comment: ${describeSubmitErrors(errors)}`, 200, 'comment_rejected');
    }
    return {
      id: json.data?.name ?? '',
      permalink: `https://www.reddit.com${json.data?.url ?? ''}`,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tracking performance                                              */
  /* ---------------------------------------------------------------- */

  /** Upvotes, downvotes and comment count for one of our submissions. */
  async getPostMetrics(redditId: string): Promise<PostMetricsSnapshot> {
    const name = redditId.startsWith('t3_') ? redditId : `t3_${redditId}`;
    const json = await this.api<{ data: { children: Array<{ data: Record<string, unknown> }> } }>(
      `/api/info.json?id=${encodeURIComponent(name)}&raw_json=1`,
    );
    const data = json.data.children[0]?.data;
    if (!data) throw new RedditApiError(`Post ${redditId} not found (deleted or removed?)`, 404, 'notfound');
    const upvotes = Number(data.ups ?? 0);
    const downvotes = Number(data.downs ?? 0);
    const total = upvotes + downvotes;
    return {
      id: String(data.id),
      score: Number(data.score ?? 0),
      upvotes,
      downvotes,
      numComments: Number(data.num_comments ?? 0),
      upvoteRatio: total > 0 ? upvotes / total : 0,
      removed: Boolean(data.removed_by_category),
      stickied: Boolean(data.stickied),
      selfText: String(data.selftext ?? ''),
      createdUtc: Number(data.created_utc ?? 0),
    };
  }

  /** Comments on one of our posts, newest last, excluding stickied mod comments. */
  async getComments(redditId: string, options: { limit?: number; sort?: 'best' | 'new' | 'top' } = {}): Promise<RedditCommentSnapshot[]> {
    const name = redditId.startsWith('t3_') ? redditId : `t3_${redditId}`;
    const permalink = await this.getPermalink(name);
    const sort = options.sort ?? 'new';
    const json = await this.api<Array<{ kind: string; data: Record<string, unknown> }>>(
      `${permalink}.json?sort=${sort}&limit=${options.limit ?? 100}&raw_json=1&depth=2`,
    );

    const post = json[0]?.data?.children as Array<{ kind: string; data: Record<string, unknown> }> | undefined;
    const commentRoot = json[1]?.data?.children as Array<{ kind: string; data: Record<string, unknown> }> | undefined;
    if (!commentRoot) return [];

    const out: Array<{ id: string; author: string; body: string; score: number; createdUtc: number }> = [];
    for (const child of commentRoot) {
      if (child.kind !== 't1') continue;
      const d = child.data;
      out.push({
        id: String(d.id),
        author: String(d.author ?? '[deleted]'),
        body: String(d.body ?? ''),
        score: Number(d.score ?? 0),
        createdUtc: Number(d.created_utc ?? 0),
      });
    }
    void post;
    return out;
  }

  private async getPermalink(name: string): Promise<string> {
    const json = await this.api<{ data: { children: Array<{ data: { permalink: string } }> } }>(
      `/api/info.json?id=${encodeURIComponent(name)}&raw_json=1`,
    );
    return json.data.children[0]?.data.permalink ?? '';
  }

  /** Delete one of our own posts (used when a post is rejected pre-publish). */
  async removePost(redditId: string): Promise<void> {
    const token = await this.ensureToken();
    const response = await this.fetchImpl(`${this.baseUrl}/api/del`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': this.userAgent,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ id: redditId }),
    });
    if (!response.ok && response.status !== 404) {
      throw new RedditApiError(`Delete failed: ${response.status}`, response.status, 'del');
    }
  }

  /** Whether a post we published is still live (removal starts a cooldown). */
  async isPostLive(redditId: string): Promise<boolean> {
    try {
      const metrics = await this.getPostMetrics(redditId);
      return !metrics.removed;
    } catch {
      return false;
    }
  }

  setTokens(tokens: RedditTokens | null): void {
    this.tokens = tokens;
  }

  setConfig(config: Partial<RedditConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/** Turn Reddit's error array into something a human can act on. */
export function describeSubmitErrors(errors: readonly unknown[]): string {
  const known: Record<string, string> = {
    SUBREDDIT_NOEXIST: 'that subreddit does not exist',
    SUBREDDIT_BANNED: 'you are banned from that subreddit',
    SUBREDDIT_FROZEN: 'that subreddit is frozen',
    SUBREDDIT_NOTALLOWED: 'you are not allowed to post there (check the sidebar rules)',
    RATELIMIT: 'you are rate limited on that subreddit - wait and try again',
    DUPLICATE_SUBMISSION: 'you already posted this exact content recently',
    TITLE_TOO_LONG: 'the title is too long',
    TITLE_TOO_SHORT: 'the title is too short',
    BAD_CAPTCHA: 'Reddit is asking for a captcha - open the site and post once manually',
    INVALID_FLAIR_TEMPLATE_ID: 'that flair no longer exists',
    USER_REQUIRED: 'this subreddit requires an authenticated account',
    THREAD_LOCKED: 'that thread is locked',
  };

  const messages: string[] = [];
  for (const error of errors) {
    if (Array.isArray(error)) {
      const [code, message, field] = error as [string, string, string];
      // Prefer our explanation of the code; Reddit's own wording is often opaque.
      const friendly = code ? known[code] : undefined;
      messages.push(friendly ?? (field ? `${field}: ${message ?? code}` : (message ?? code)));
    } else if (typeof error === 'string') {
      const code = /^[A-Z_]{3,}/.exec(error)?.[0];
      messages.push((code && known[code]) ?? error);
    }
  }
  return messages.join('; ');
}