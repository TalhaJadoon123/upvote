import { describe, expect, it, vi } from 'vitest';
import {
  describeSubmitErrors,
  pickFlairId,
  RedditApiError,
  RedditClient,
  REDDIT_AUTH_BASE,
  USER_AGENT,
} from '@upvote/reddit';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function clientWithFetch(fetchImpl: typeof fetch, tokens: unknown = { accessToken: 'tok' }) {
  return new RedditClient({
    clientId: 'cid',
    clientSecret: 'secret',
    redirectUri: 'http://localhost/cb',
    tokens: tokens as never,
    fetchImpl,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
}

describe('configuration', () => {
  it('reports whether it is configured and authenticated', () => {
    const anon = new RedditClient({ clientId: '', clientSecret: '' });
    expect(anon.configured).toBe(false);
    expect(anon.authenticated).toBe(false);
    const ready = new RedditClient({ clientId: 'a', clientSecret: 'b' });
    expect(ready.configured).toBe(true);
    expect(ready.authenticated).toBe(false);
  });

  it('sends a descriptive user agent', () => {
    expect(USER_AGENT('1.2.3')).toBe('node:upvote:v1.2.3 (by /u/upvote_app) - Reddit growth engine');
  });
});

describe('authorizeUrl', () => {
  it('builds an install URL with state, scopes and a permanent grant', () => {
    const client = new RedditClient({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://localhost/cb' });
    const url = new URL(client.authorizeUrl('state-123'));
    expect(`${url.origin}${url.pathname}`).toBe(`${REDDIT_AUTH_BASE}/api/v1/authorize`);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('duration')).toBe('permanent');
    expect(url.searchParams.get('scope')).toContain('submit');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/cb');
  });
});

describe('token exchange', () => {
  it('exchanges a code for tokens with basic auth', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(
        `Basic ${Buffer.from('cid:secret').toString('base64')}`,
      );
      expect(String(init?.body)).toContain('grant_type=authorization_code');
      return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'identity submit' });
    });
    const client = new RedditClient({
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'http://localhost/cb',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const tokens = await client.exchangeCode('the-code');
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(client.authenticated).toBe(true);
    expect(tokens.obtainedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('fails loudly when credentials are missing', async () => {
    const client = new RedditClient({ clientId: '', clientSecret: '', fetchImpl: (async () => new Response()) as never });
    await expect(client.exchangeCode('x')).rejects.toThrow(/not configured/i);
  });

  it('refuses to refresh without a refresh token', async () => {
    const client = clientWithFetch(async () => new Response());
    await expect(client.refreshTokens()).rejects.toThrow(/reinstall/i);
  });
});

describe('token refresh', () => {
  it('refreshes automatically when the access token has expired', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('access_token')) {
        return jsonResponse({ access_token: 'fresh', refresh_token: 'rt', expires_in: 3600 });
      }
      return jsonResponse({ name: 'dev' });
    });

    const client = new RedditClient({
      clientId: 'cid',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokens: {
        accessToken: 'stale',
        refreshToken: 'rt',
        expiresIn: 3600,
        obtainedAt: '2020-01-01T00:00:00.000Z',
      },
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const me = await client.me();
    expect(me.name).toBe('dev');
    expect(calls[0]).toContain('access_token');
    expect(calls[1]).toContain('/api/v1/me');
  });

  it('retries once after a 401', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('access_token')) {
        return jsonResponse({ access_token: 'fresh2', refresh_token: 'rt', expires_in: 3600 });
      }
      attempt++;
      return attempt === 1 ? new Response('nope', { status: 401 }) : jsonResponse({ name: 'dev' });
    });
    const client = new RedditClient({
      clientId: 'cid',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokens: { accessToken: 'good', refreshToken: 'rt', expiresIn: 3600, obtainedAt: '2026-01-01T00:00:00Z' },
      now: () => new Date('2026-01-01T00:05:00Z'),
    });
    await expect(client.me()).resolves.toMatchObject({ name: 'dev' });
    expect(attempt).toBe(2);
  });

  it('surfaces a 429 with the retry delay', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '37' } }),
    );
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(client.me()).rejects.toThrow(/Retry in 37s/);
  });

  it('refuses to call the API without a token', async () => {
    const client = new RedditClient({ clientId: 'a', clientSecret: 'b' });
    await expect(client.me()).rejects.toThrow(/Not connected to Reddit/);
  });
});

describe('submit', () => {
  const ok = () => jsonResponse({ errors: [], data: { id: 'abc', name: 't3_abc', url: '/r/webdev/comments/abc/x/' } });

  it('posts a text submission with the founder token', async () => {
    let seenBody = '';
    let seenAuth = '';
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body);
      seenAuth = (init?.headers as Record<string, string>).authorization ?? '';
      return ok();
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    const result = await client.submit({
      subreddit: '/r/webdev',
      title: 'the retry cache was the bug',
      text: 'body text',
      flairId: 'flair-1',
    });
    expect(seenAuth).toBe('Bearer tok');
    expect(seenBody).toContain('sr=webdev');
    expect(seenBody).toContain('kind=self');
    expect(seenBody).toContain('flair_id=flair-1');
    expect(result.id).toBe('t3_abc');
    expect(result.permalink).toContain('/r/webdev/comments/abc/x/');
  });

  it('posts a link submission', async () => {
    let seenBody = '';
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBody = String(init?.body);
      return ok();
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await client.submit({ subreddit: 'SaaS', title: 't', link: 'https://acme.dev' });
    expect(seenBody).toContain('kind=link');
    expect(seenBody).toContain('url=');
  });

  it('refuses a post with neither text nor link', async () => {
    const client = clientWithFetch(async () => ok());
    await expect(client.submit({ subreddit: 'x', title: 't' })).rejects.toThrow(/text or a link/i);
  });

  it('turns Reddit rule errors into actionable messages', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [['RATELIMIT', 'you are doing that too much', 'ratelimit']], data: null }),
    );
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(client.submit({ subreddit: 'x', title: 't', text: 'b' })).rejects.toThrow(/rate limited/);
  });

  it('reports a captcha requirement clearly', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [['BAD_CAPTCHA', 'care to try these again', 'captcha']] }));
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(client.submit({ subreddit: 'x', title: 't', text: 'b' })).rejects.toThrow(/captcha/);
  });
});

describe('comment', () => {
  it('posts a reply to a parent', async () => {
    let seenBody = '';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/comment')) {
        seenBody = String(init?.body);
        return jsonResponse({ errors: [], data: { name: 'c1', url: '/r/webdev/comments/x/y/_/z/' } });
      }
      return new Response('', { status: 404 });
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    const result = await client.comment('t3_abc', 'good point, i hit the same thing');
    expect(seenBody).toContain('thing_id=t3_abc');
    expect(result.id).toBe('c1');
  });
});

describe('metrics', () => {
  it('reads upvotes, downvotes and comment counts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { children: [{ data: { id: 'abc', score: 87, ups: 88, downs: 1, num_comments: 14, selftext: 'x', created_utc: 1 } }] },
      }),
    );
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    const metrics = await client.getPostMetrics('abc');
    expect(metrics.upvotes).toBe(88);
    expect(metrics.downvotes).toBe(1);
    expect(metrics.numComments).toBe(14);
    expect(metrics.upvoteRatio).toBeCloseTo(88 / 89, 3);
    expect(metrics.removed).toBe(false);
  });

  it('detects a removed post', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { children: [{ data: { id: 'abc', removed_by_category: 'moderator' } }] } }),
    );
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    expect((await client.getPostMetrics('abc')).removed).toBe(true);
    await expect(client.isPostLive('abc')).resolves.toBe(false);
  });

  it('throws when the post is gone', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { children: [] } }));
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(client.getPostMetrics('gone')).rejects.toThrow(/deleted or removed/i);
    await expect(client.isPostLive('gone')).resolves.toBe(false);
  });
});

describe('getComments', () => {
  it('returns comments for the reply-suggestion engine', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/info.json')) {
        return jsonResponse({ data: { children: [{ data: { permalink: '/r/webdev/comments/abc/x/' } }] } });
      }
      return jsonResponse([
        { kind: 'Listing', data: { children: [] } },
        {
          kind: 'Listing',
          data: {
            children: [
              { kind: 't1', data: { id: 'c1', author: 'dev_dan', body: 'how are you batching?', score: 4, created_utc: 2 } },
              { kind: 't1', data: { id: 'c2', author: '[deleted]', body: '', score: 0, created_utc: 3 } },
              { kind: 'more', data: {} },
            ],
          },
        },
      ]);
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    const comments = await client.getComments('abc');
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ author: 'dev_dan', body: 'how are you batching?' });
    expect(comments[1]?.author).toBe('[deleted]');
  });
});

describe('subreddit metadata', () => {
  it('builds a profile from about + sidebar', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/about/sidebar')) {
        return jsonResponse({ data: '<p>Rule 1: No self promotion.</p>' });
      }
      return jsonResponse({ data: { display_name: 'webdev', subscribers: 900000, public_description: 'web devs' } });
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    const profile = await client.getSubredditProfile('/r/webdev');
    expect(profile.name).toBe('webdev');
    expect(profile.subscribers).toBe(900000);
    expect(profile.allowSelfPromo).toBe(false);
    expect(profile.rules.some((r) => r.kind === 'no_selfpromo')).toBe(true);
  });

  it('survives a subreddit with no sidebar', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/about/sidebar') ? new Response('', { status: 404 }) : jsonResponse({ data: { display_name: 'x' } }),
    );
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    const profile = await client.getSubredditProfile('x');
    expect(profile.name).toBe('x');
    expect(profile.rules).toEqual([]);
  });

  it('builds a 24-bucket activity curve from top posts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          children: [
            { data: { created_utc: Math.floor(Date.UTC(2026, 0, 1, 9) / 1000), score: 500 } },
            { data: { created_utc: Math.floor(Date.UTC(2026, 0, 1, 9, 30) / 1000), score: 10 } },
            { data: { created_utc: Math.floor(Date.UTC(2026, 0, 2, 3) / 1000), score: 0 } },
          ],
        },
      }),
    );
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    const curve = await client.sampleActivityByHour('webdev');
    expect(curve).toHaveLength(24);
    expect(curve[9]).toBeGreaterThan(0);
    expect(curve[9]).toBeGreaterThan(curve[3] ?? 0);
  });

  it('returns an empty flair list when the subreddit has none', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(client.getFlairs('x')).resolves.toEqual([]);
  });
});

describe('engaged subreddits', () => {
  it('unions posted and commented subs and tolerates failures', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('submitted')) return jsonResponse([{ data: { subreddit: 'webdev' } }]);
      if (url.includes('commented')) return jsonResponse([{ data: { subreddit: 'programming' } }, { data: { subreddit: 'webdev' } }]);
      return new Response('', { status: 404 });
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(client.listEngagedSubreddits()).resolves.toEqual(['webdev', 'programming']);
  });

  it('returns an empty list when both calls fail', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await expect(client.listEngagedSubreddits()).resolves.toEqual([]);
  });
});

describe('pickFlairId', () => {
  const flairs = [
    { id: '1', text: 'Discussion' },
    { id: '2', text: 'Show & Tell' },
    { id: '3', text: 'News' },
  ];

  it('matches exactly', () => {
    expect(pickFlairId(flairs, 'Show & Tell')).toBe('2');
  });

  it('falls back on word overlap', () => {
    expect(pickFlairId(flairs, 'show')).toBe('2');
  });

  it('prefers a discussion flair over news for unknown input', () => {
    expect(['1', '2']).toContain(pickFlairId(flairs, 'something unlisted'));
  });

  it('uses the first template when no flair is suggested', () => {
    expect(pickFlairId(flairs, '')).toBe('1');
  });

  it('returns undefined when the subreddit has no flairs', () => {
    expect(pickFlairId([], 'Discussion')).toBeUndefined();
  });
});

describe('describeSubmitErrors', () => {
  it('explains known Reddit error codes', () => {
    const message = describeSubmitErrors([['SUBREDDIT_BANNED', 'you are banned', 'subreddit']]);
    expect(message).toMatch(/banned/);
    expect(message).not.toContain('subreddit:');
  });

  it('passes through unknown errors', () => {
    expect(describeSubmitErrors([['WEIRD_CODE', 'something odd']])).toContain('something odd');
  });

  it('handles an empty error list', () => {
    expect(describeSubmitErrors([])).toBe('');
  });
});

describe('RedditApiError', () => {
  it('carries the status and type', () => {
    const error = new RedditApiError('boom', 403, 'forbidden');
    expect(error.status).toBe(403);
    expect(error.errorType).toBe('forbidden');
    expect(error.name).toBe('RedditApiError');
  });
});

describe('getMyActivity', () => {
  it('returns the raw listing children for voice training', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/v1/me/posts_and_comments');
      expect(url).toContain('limit=25');
      return jsonResponse({
        kind: 'Listing',
        data: {
          children: [
            { kind: 't3', data: { id: 'p1', title: 'I rewrote the ingest layer', selftext: 'The retry loop cached its own failures, which was embarrassing.', score: 240 } },
            { kind: 't1', data: { id: 'c1', body: 'this matches my experience, the docs are wrong', score: 12 } },
          ],
        },
      });
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    const children = await client.getMyActivity({ limit: 25 });
    expect(children).toHaveLength(2);
    expect(children[0]?.kind).toBe('t3');
    expect(children[1]?.kind).toBe('t1');
  });

  it('can fetch only comments', async () => {
    let seenUrl = '';
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrl = url;
      return jsonResponse({ kind: 'Listing', data: { children: [] } });
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);
    await client.getMyActivity({ types: ['comments'] });
    expect(seenUrl).toContain('/api/v1/me/comments');
  });
});