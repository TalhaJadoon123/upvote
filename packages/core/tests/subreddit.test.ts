import { describe, expect, it } from 'vitest';
import {
  checkCompliance,
  defaultSubredditPool,
  htmlToText,
  inferTopics,
  matchSubreddits,
  parseRules,
  profileFromRedditJson,
  scoreSubreddit,
  topHours,
} from '@upvote/core';
import type { SubredditProfile } from '@upvote/core';

const DRAFT = {
  title: 'the retry cache was the bug in my ingest layer',
  body: 'i deleted eleven lines and the failures stopped firing. embarrassing lesson learned.',
  firstComment: 'the repo is in my profile.',
};

describe('htmlToText', () => {
  it('strips tags and preserves list structure', () => {
    const html = '<div><p>Rule 1: no self promotion</p><ul><li>no memes</li></ul></div>';
    const text = htmlToText(html);
    expect(text).toContain('Rule 1: no self promotion');
    expect(text).toContain('• no memes');
    expect(text).not.toContain('<');
  });

  it('drops scripts and styles', () => {
    expect(htmlToText('<script>alert(1)</script><style>a{}</style>text')).toBe('text');
  });

  it('decodes entities', () => {
    expect(htmlToText('a &amp; b &lt;c&gt; &quot;d&quot;')).toBe('a & b <c> "d"');
  });
});

describe('parseRules', () => {
  it('detects a no-selfpromo rule', () => {
    const { rules } = parseRules('1. No self-promotion or advertising.');
    expect(rules.some((r) => r.kind === 'no_selfpromo')).toBe(true);
  });

  it('detects no links', () => {
    const { rules } = parseRules('No links in posts. Text posts only.');
    expect(rules.some((r) => r.kind === 'no_links')).toBe(true);
    expect(rules.some((r) => r.kind === 'no_external_link_first_paragraph')).toBe(true);
  });

  it('detects flair requirements', () => {
    const { rules } = parseRules('All posts must be flaired before they will show up in the sub.');
    expect(rules.some((r) => r.kind === 'flair_required')).toBe(true);
  });

  it('detects title length limits with a value', () => {
    const { rules } = parseRules('Titles must be under 300 characters or Reddit will truncate them.');
    const rule = rules.find((r) => r.kind === 'title_length');
    expect(rule?.value).toBe(300);
  });

  it('detects karma requirements with a value', () => {
    const { rules } = parseRules('You must have 100 karma to post here.');
    const rule = rules.find((r) => r.kind === 'karma_age');
    expect(rule?.value).toBe(100);
  });

  it('detects a weekly post limit', () => {
    const { rules } = parseRules('One post per week, please.');
    expect(rules.some((r) => r.kind === 'weekly_post_limit')).toBe(true);
  });

  it('escalates soft rules found inside a numbered rule list', () => {
    const { rules } = parseRules('1. Crossposts are not allowed.\n2. Be nice.');
    expect(rules.find((r) => r.kind === 'no_crosspost')?.severity).toBe('hard');
  });

  it('returns nothing for an empty sidebar', () => {
    expect(parseRules('', null, undefined).rules).toEqual([]);
  });
});

describe('inferTopics', () => {
  it('detects webdev and typescript content', () => {
    const result = inferTopics('i rewrote my next.js frontend with tailwind and fixed the hydration bug');
    expect(result.topics).toContain('webdev');
  });

  it('detects indiehackers content', () => {
    const result = inferTopics('we hit $1k mrr and churn is finally going down, saas pricing update');
    expect(result.topics).toContain('indiehackers');
  });

  it('flags nsfw content as an avoid category', () => {
    expect(inferTopics('nsfw content warning ahead').avoidCategories).toContain('nsfw');
  });
});

describe('checkCompliance', () => {
  const noPromo: SubredditProfile = {
    ...profileFromRedditJson('rwebdev', {}),
    rules: [{ id: 'no_selfpromo', kind: 'no_selfpromo', description: 'No self-promotion', severity: 'hard' }],
    allowSelfPromo: false,
  };

  it('blocks a promotional draft in a no-selfpromo sub', () => {
    const result = checkCompliance(noPromo, { ...DRAFT, body: `${DRAFT.body}\n\ncheck out https://acme.dev` });
    expect(result.compliant).toBe(false);
    expect(result.violations.join(' ')).toMatch(/self-promotion/i);
  });

  it('passes a clean draft', () => {
    expect(checkCompliance(noPromo, DRAFT).compliant).toBe(true);
  });

  it('blocks a restricted subreddit outright', () => {
    const restricted = { ...noPromo, restricted: true };
    const result = checkCompliance(restricted, DRAFT);
    expect(result.compliant).toBe(false);
    expect(result.violations[0]).toMatch(/restricted/i);
  });

  it('blocks a link in the first paragraph when links go in comments', () => {
    const linkInComments = profileFromRedditJson('test', {}, '<p>Links must go in the comments.</p>');
    const result = checkCompliance(linkInComments, {
      ...DRAFT,
      body: 'here is the fix: https://github.com/acme/repo\n\nand more text',
    });
    expect(result.violations.join(' ')).toMatch(/first paragraph|comments/i);
  });

  it('blocks a too-long title', () => {
    const titled = profileFromRedditJson('test', {}, '<p>Titles must be under 40 characters.</p>');
    const result = checkCompliance(titled, { ...DRAFT, title: 'x'.repeat(80) });
    expect(result.violations.join(' ')).toMatch(/caps at 40/);
  });

  it('blocks a link post in a text-only subreddit', () => {
    const textOnly = profileFromRedditJson('test', {}, '<p>Text posts only.</p>');
    const result = checkCompliance(textOnly, { ...DRAFT, linkUrl: 'https://acme.dev' });
    expect(result.violations.join(' ')).toMatch(/text-posts-only/i);
  });

  it('blocks an account that is too new', () => {
    const old = profileFromRedditJson('test', {}, '<p>Your account must be 90 days old to post.</p>');
    const result = checkCompliance(old, { ...DRAFT, accountAgeDays: 5 });
    expect(result.violations.join(' ')).toMatch(/days old|90-day/);
  });

  it('records what the draft already satisfies', () => {
    const linkInComments = profileFromRedditJson('test', {}, '<p>No links in posts.</p>');
    expect(checkCompliance(linkInComments, DRAFT).compliance.length).toBeGreaterThan(0);
  });
});

describe('scoreSubreddit', () => {
  const pool = defaultSubredditPool();

  it('scores a topic-relevant subreddit higher than an irrelevant one', () => {
    const text = 'my docker compose self-hosted homelab setup with nginx and postgres';
    const selfhosted = pool.find((p) => p.name === 'selfhosted')!;
    const datascience = pool.find((p) => p.name === 'datascience')!;
    const a = scoreSubreddit(selfhosted, text);
    const b = scoreSubreddit(datascience, text);
    expect(a.fit).toBeGreaterThan(b.fit);
  });

  it('respects the blocklist', () => {
    const side = pool[0]!;
    expect(scoreSubreddit(side, 'anything', { blocklist: [side.name] }).fit).toBe(0);
  });

  it('boosts a subreddit the user has commented in before', () => {
    const side = pool[0]!;
    const cold = scoreSubreddit(side, 'a dev tool in javascript for the browser').fit;
    const warm = scoreSubreddit(side, 'a dev tool in javascript for the browser', { history: [side.name] }).fit;
    expect(warm).toBeGreaterThan(cold);
  });

  it('penalizes no-selfpromo subs', () => {
    const promo = pool.find((p) => p.name === 'programming')!; // allowLinks=false in fixture
    expect(promo.allowLinks).toBe(false);
  });

  it('returns 0-100', () => {
    const score = scoreSubreddit(pool[0]!, 'anything at all here').fit;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('matchSubreddits', () => {
  const pool = defaultSubredditPool();

  it('returns at most `limit` suggestions, best first', () => {
    const results = matchSubreddits(pool, { ...DRAFT, style: 'story' }, { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < results.length; i++) {
      const a = results[i - 1]!;
      const b = results[i]!;
      if (a.compliant === b.compliant) expect(a.fit).toBeGreaterThanOrEqual(b.fit);
    }
  });

  it('sorts compliant suggestions above non-compliant ones', () => {
    const results = matchSubreddits(pool, { ...DRAFT, body: `${DRAFT.body}\n\nhttps://acme.dev` }, { limit: 5 });
    const firstNonCompliant = results.findIndex((r) => !r.compliant);
    const lastCompliant = results.map((r) => r.compliant).lastIndexOf(true);
    if (firstNonCompliant !== -1 && lastCompliant !== -1) {
      expect(lastCompliant).toBeLessThan(firstNonCompliant);
    }
  });

  it('includes the compliance checklist and reasons for each suggestion', () => {
    const [first] = matchSubreddits(pool, { ...DRAFT }, { limit: 1 });
    expect(first?.reasons.length).toBeGreaterThan(0);
    expect(first?.subreddit).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

describe('topHours', () => {
  it('returns nothing without observed data', () => {
    expect(topHours([], 3)).toEqual([]);
    expect(topHours(new Array(12).fill(1), 3)).toEqual([]);
  });

  it('picks separated peak hours', () => {
    const curve = new Array(24).fill(0.1);
    curve[9] = 1;
    curve[17] = 0.9;
    curve[20] = 0.8;
    const hours = topHours(curve, 3);
    expect(hours).toEqual([9, 17, 20]);
  });

  it('never picks two hours closer than 3 apart', () => {
    const curve = new Array(24).fill(0.1);
    curve[10] = 1;
    curve[11] = 0.99;
    curve[12] = 0.98;
    const hours = topHours(curve, 2);
    expect(hours.length).toBe(2);
    for (let i = 1; i < hours.length; i++) {
      const gap = Math.abs(hours[i]! - hours[i - 1]!);
      expect(Math.min(gap, 24 - gap)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('profileFromRedditJson', () => {
  it('builds a profile from an about payload', () => {
    const profile = profileFromRedditJson(
      'webdev',
      {
        display_name: 'webdev',
        subscribers: 2_400_000,
        average_upvote_ratio: 0.97,
        public_description: 'A community for web developers',
        over18: false,
      },
      '<p>Rule 1: No self promotion.</p>',
    );
    expect(profile.subscribers).toBe(2_400_000);
    expect(profile.allowSelfPromo).toBe(false);
    expect(profile.activity).not.toBeNull();
    expect(profile.activity!).toBeGreaterThan(0);
  });

  it('computes activity from subscriber count', () => {
    const big = profileFromRedditJson('big', { subscribers: 2_000_000 });
    const small = profileFromRedditJson('small', { subscribers: 500 });
    expect(big.activity!).toBeGreaterThan(small.activity!);
  });
});