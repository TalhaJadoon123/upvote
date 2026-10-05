import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildCrossPost,
  createDevToClient,
  createHashnodeClient,
  crossPostToAll,
  devtoTagsFor,
  hashnodeTagsFor,
  mapTags,
  parseLemonSqueezyEvent,
  parsePaddleEvent,
  planFromLemonVariant,
  verifyLemonSqueezySignature,
  verifyPaddleSignature,
} from '@upvote/core';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

/* ------------------------------------------------------------------ */
/* Lemon Squeezy                                                       */
/* ------------------------------------------------------------------ */

const LEMON_SECRET = 'lemon-secret';

function lemonSignature(body: string, secret = LEMON_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('Lemon Squeezy signatures', () => {
  const body = JSON.stringify({ meta: { event_name: 'subscription_created' } });

  it('accepts a valid signature', () => {
    expect(verifyLemonSqueezySignature(body, lemonSignature(body), LEMON_SECRET)).toBe(true);
  });

  it('rejects a tampered body, wrong secret, or missing header', () => {
    expect(verifyLemonSqueezySignature(`${body} `, lemonSignature(body), LEMON_SECRET)).toBe(false);
    expect(verifyLemonSqueezySignature(body, lemonSignature(body), 'other')).toBe(false);
    expect(verifyLemonSqueezySignature(body, null, LEMON_SECRET)).toBe(false);
    expect(verifyLemonSqueezySignature(body, lemonSignature(body), undefined)).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    expect(verifyLemonSqueezySignature(body, 'not-hex', LEMON_SECRET)).toBe(false);
  });
});

describe('Lemon Squeezy events', () => {
  it('maps a subscription to the right plan', () => {
    const result = parseLemonSqueezyEvent(
      JSON.stringify({
        meta: { event_name: 'subscription_created', custom_data: { clerkId: 'user_123' } },
        data: { id: 'sub_1', attributes: { variant_id: 'lemon_upvote_pro', status: 'active' } },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.event?.plan).toBe('pro');
    expect(result.event?.clerkId).toBe('user_123');
    expect(result.event?.subscriptionId).toBe('sub_1');
  });

  it('drops to free on cancellation or expiry', () => {
    for (const type of ['subscription_cancelled', 'subscription_expired']) {
      const result = parseLemonSqueezyEvent(
        JSON.stringify({
          meta: { event_name: type },
          data: { attributes: { variant_id: 'lemon_upvote_team', status: 'active' } },
        }),
      );
      expect(result.event?.plan, `${type} should drop to free`).toBe('free');
    }
  });

  it('drops to free for an expired status regardless of event name', () => {
    const result = parseLemonSqueezyEvent(
      JSON.stringify({
        meta: { event_name: 'subscription_updated' },
        data: { attributes: { variant_id: 'lemon_upvote_pro', status: 'expired' } },
      }),
    );
    expect(result.event?.plan).toBe('free');
  });

  it('never grants a paid plan for an unknown variant', () => {
    expect(planFromLemonVariant('lemon_something_else')).toBe('free');
    expect(planFromLemonVariant(undefined)).toBe('free');
    expect(planFromLemonVariant('lemon_upvote_team')).toBe('team');
  });

  it('rejects a body that is not JSON', () => {
    expect(parseLemonSqueezyEvent('not json').ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Paddle                                                              */
/* ------------------------------------------------------------------ */

const PADDLE_SECRET = 'paddle-secret';

function paddleHeader(body: string, ts: number, secret = PADDLE_SECRET): string {
  const h1 = createHmac('sha256', secret).update(`${ts}:${body}`, 'utf8').digest('base64');
  return `ts=${ts};h1=${h1}`;
}

describe('Paddle signatures', () => {
  const body = JSON.stringify({ event_type: 'subscription.created', data: {} });

  it('accepts a valid signature', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyPaddleSignature(body, paddleHeader(body, ts), PADDLE_SECRET)).toBe(true);
  });

  it('rejects a stale signature, which blocks replay', () => {
    const old = Math.floor(Date.now() / 1000) - 4000;
    expect(verifyPaddleSignature(body, paddleHeader(body, old), PADDLE_SECRET)).toBe(false);
  });

  it('rejects a tampered body and a bad header', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyPaddleSignature(`${body} `, paddleHeader(body, ts), PADDLE_SECRET)).toBe(false);
    expect(verifyPaddleSignature(body, 'garbage', PADDLE_SECRET)).toBe(false);
    expect(verifyPaddleSignature(body, null, PADDLE_SECRET)).toBe(false);
  });
});

describe('Paddle events', () => {
  it('maps a price id to the plan', () => {
    const result = parsePaddleEvent(
      JSON.stringify({
        event_type: 'subscription.created',
        occurred_at: '2026-01-01T00:00:00Z',
        data: { id: 'sub_9', status: 'active', custom_data: { clerkId: 'user_9' }, items: [{ price: { id: 'pdl_upvote_pro_monthly' } }] },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.event?.plan).toBe('pro');
    expect(result.event?.clerkId).toBe('user_9');
  });

  it('drops to free when the subscription is cancelled or paused', () => {
    for (const eventType of ['subscription.cancelled', 'subscription.paused']) {
      const result = parsePaddleEvent(
        JSON.stringify({
          event_type: eventType,
          data: { status: 'active', items: [{ price: { id: 'pdl_upvote_team_monthly' } }] },
        }),
      );
      expect(result.event?.plan).toBe('free');
    }
  });

  it('falls back to custom_data when the price id is unknown', () => {
    const result = parsePaddleEvent(
      JSON.stringify({
        event_type: 'transaction.completed',
        data: { items: [{ price: { id: 'pri_unknown', custom_data: { upvote_plan: 'team' } } }] },
      }),
    );
    expect(result.event?.plan).toBe('team');
  });

  it('rejects a body that is not JSON', () => {
    expect(parsePaddleEvent('<xml/>').ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Cross-posting                                                       */
/* ------------------------------------------------------------------ */

describe('tag mapping', () => {
  it('maps known topics onto platform tags', () => {
    expect(devtoTagsFor(['webdev'])).toEqual(['webdev']);
    expect(hashnodeTagsFor(['programming'])).toEqual(['programming']);
  });

  it('fuzzy-matches near misses', () => {
    expect(devtoTagsFor(['web-development'])).toEqual(['webdev']);
  });

  it('falls back to a valid tag rather than inventing one', () => {
    expect(devtoTagsFor(['quantum-bananas'])).toEqual(['programming']);
    expect(devtoTagsFor([])).toEqual(['programming']);
  });

  it('caps at four tags', () => {
    const tags = mapTags(['webdev', 'typescript', 'react', 'python', 'docker', 'security'], ['webdev', 'typescript', 'react', 'python', 'docker', 'security'], 'programming');
    expect(tags.length).toBeLessThanOrEqual(4);
  });
});

describe('buildCrossPost', () => {
  const draft = {
    title: 'the retry cache was the bug',
    body: 'i deleted eleven lines and the failures stopped firing.',
    firstComment: 'the boring version first.',
    subreddit: 'programming',
    permalink: 'https://reddit.com/r/programming/comments/abc/x/',
  };

  it('produces a valid dev.to target', () => {
    const target = buildCrossPost(draft, 'devto');
    expect(target.platform).toBe('devto');
    expect(target.title.length).toBeLessThanOrEqual(30);
    expect(target.tags.length).toBeLessThanOrEqual(4);
    expect(target.bodyMarkdown).toContain('eleven lines');
    expect(target.bodyMarkdown).toContain('reddit.com');
  });

  it('allows the longer Hashnode title', () => {
    const long = { ...draft, title: 'a'.repeat(60) };
    expect(buildCrossPost(long, 'hashnode').title).toHaveLength(50);
  });
});

describe('dev.to client', () => {
  it('creates an article', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 42, url: 'https://dev.to/x/42' }));
    const client = createDevToClient({ apiKey: 'k' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.create(buildCrossPost({ title: 'hi', body: 'b', firstComment: '', subreddit: 'programming' }, 'devto'));
    expect(result.ok).toBe(true);
    expect(result.url).toBe('https://dev.to/x/42');
  });

  it('rejects an over-long title before making a request', async () => {
    const fetchImpl = vi.fn();
    const client = createDevToClient({ apiKey: 'k' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.create({ platform: 'devto', title: 'a'.repeat(40), bodyMarkdown: 'b', tags: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/30/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces the API error message', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'Title is too long' }, { status: 422 }));
    const client = createDevToClient({ apiKey: 'k' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.create({ platform: 'devto', title: 'ok', bodyMarkdown: 'b', tags: ['programming'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Title is too long');
  });
});

describe('Hashnode client', () => {
  it('creates a publication post', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: { createPublicationPost: { post: { id: 'p1', url: 'https://hashnode.dev/p1' } } } }),
    );
    const client = createHashnodeClient({ token: 't' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.create(buildCrossPost({ title: 'hi', body: 'b', firstComment: '', subreddit: 'programming' }, 'hashnode'));
    expect(result.ok).toBe(true);
    expect(result.url).toBe('https://hashnode.dev/p1');
  });

  it('reports GraphQL errors', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: { createPublicationPost: { errors: [{ message: 'Not authorized' }] } } }),
    );
    const client = createHashnodeClient({ token: 'bad' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.create({ platform: 'hashnode', title: 'hi', bodyMarkdown: 'b', tags: ['programming'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Not authorized');
  });

  it('fails loudly when the mutation returns no URL', async () => {
    const fetchImpl = vi.fn(async () => json({ data: { createPublicationPost: { post: {} } } }));
    const client = createHashnodeClient({ token: 't' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.create({ platform: 'hashnode', title: 'hi', bodyMarkdown: 'b', tags: ['programming'] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no post URL/i);
  });
});

describe('crossPostToAll', () => {
  it('reports per-platform results and does not stop at the first failure', async () => {
    const draft = { title: 'hi', body: 'b', firstComment: '', subreddit: 'programming' };
    const results = await crossPostToAll(draft, [
      { platform: 'devto', client: createDevToClient({ apiKey: 'k' }, { fetchImpl: (async () => json({ url: 'https://dev.to/1' })) as never }) },
      { platform: 'hashnode', client: createHashnodeClient({ token: 't' }, { fetchImpl: (async () => new Response('boom', { status: 500 })) as never }) },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
  });
});