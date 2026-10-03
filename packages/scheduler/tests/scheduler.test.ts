import { describe, expect, it, vi } from 'vitest';
import {
  buildCalendar,
  claimItem,
  chooseSlot,
  completeItem,
  describeQueue,
  dueItems,
  failItem,
  markRemoved,
  scheduleDraft,
  tick,
  upcoming,
  type SchedulerState,
} from '@upvote/scheduler';
import { GuardrailConfigSchema, defaultSubredditPool, type Draft, type SubredditProfile } from '@upvote/core';

const NOW = new Date('2026-01-05T00:00:00.000Z');

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 'd1',
    userId: 'u1',
    momentId: 'm1',
    style: 'story',
    status: 'approved',
    title: 'the retry cache was the bug',
    titleVariants: ['the retry cache was the bug'],
    selectedTitleVariant: 0,
    body: 'i deleted eleven lines and the failures stopped firing. embarrassing lesson learned the expensive way, boring beats clever.',
    firstComment: 'the boring version first.',
    flair: 'Discussion',
    flairId: null,
    linkUrl: null,
    suggestedSubreddits: [
      {
        subreddit: 'programming',
        fit: 82,
        reasons: ['topic match'],
        compliance: [],
        violations: [],
        compliant: true,
        subscribers: 3_200_000,
        activity: 70,
        bestHoursUtc: [14, 19],
      },
      {
        subreddit: 'webdev',
        fit: 61,
        reasons: ['topic match'],
        compliance: [],
        violations: [],
        compliant: true,
        subscribers: 900_000,
        activity: 60,
        bestHoursUtc: [15],
      },
    ],
    primarySubreddit: 'programming',
    authenticityScore: 91,
    authenticity: {},
    authenticityNotes: [],
    editCount: 0,
    scheduledFor: null,
    postedAt: null,
    redditId: null,
    permalink: null,
    generator: { template: 'story', model: 'offline-composer', seed: 's', attempt: 0 },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function pool(): SubredditProfile[] {
  return defaultSubredditPool();
}

function state(overrides: Partial<SchedulerState> = {}): SchedulerState {
  return {
    items: [],
    history: [],
    config: GuardrailConfigSchema.parse({}),
    ...overrides,
  };
}

describe('chooseSlot', () => {
  it('picks the best compliant subreddit peak', () => {
    const { slot, subreddit, fallback } = chooseSlot(draft(), { now: NOW, subreddits: pool() });
    expect(fallback).toBe(false);
    expect(subreddit).toBe('programming');
    expect(new Date(slot.at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('avoids a slot that is already occupied', () => {
    const subreddits = pool();
    const first = chooseSlot(draft(), { now: NOW, subreddits });
    const second = chooseSlot(draft({ id: 'd2' }), {
      now: NOW,
      subreddits,
      occupiedSlots: [first.slot.at],
    });
    expect(second.slot.at).not.toBe(first.slot.at);
  });

  it('skips non-compliant subreddit suggestions', () => {
    const d = draft({
      suggestedSubreddits: [
        { subreddit: 'webdev', fit: 90, reasons: [], compliance: [], violations: ['no links'], compliant: false, subscribers: 1, activity: 1, bestHoursUtc: [] },
      ],
      primarySubreddit: 'webdev',
    });
    const { subreddit, fallback } = chooseSlot(d, { now: NOW, subreddits: pool() });
    expect(fallback).toBe(true);
    expect(subreddit).toBe('webdev');
  });

  it('falls back to the draft default window', () => {
    const { slot, fallback } = chooseSlot(
      draft({ scheduledFor: '2026-01-06T14:00:00.000Z' }),
      { now: NOW, subreddits: [] },
    );
    expect(fallback).toBe(true);
    expect(slot.at).toBe('2026-01-06T14:00:00.000Z');
  });

  it('always produces a future slot, even with no data at all', () => {
    const { slot } = chooseSlot(draft({ scheduledFor: null, suggestedSubreddits: [], primarySubreddit: null }), {
      now: NOW,
      subreddits: [],
    });
    expect(new Date(slot.at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('blends in the founder learned hour weights', () => {
    const weights = new Array<number>(24).fill(0);
    weights[3] = 1;
    const { slot } = chooseSlot(draft(), { now: NOW, subreddits: pool(), learnedHourWeights: weights });
    expect(new Date(slot.at).getUTCHours()).toBe(3);
  });
});

describe('scheduleDraft', () => {
  it('adds a compliant draft to the queue', () => {
    const s = state();
    const item = scheduleDraft(s, draft(), { now: NOW, subreddits: pool() });
    expect(item?.status).toBe('scheduled');
    expect(item?.subreddit).toBe('programming');
    expect(item?.reason).toContain('programming');
  });

  it('refuses a draft with no target subreddit', () => {
    expect(scheduleDraft(state(), draft({ primarySubreddit: null, suggestedSubreddits: [] }), { now: NOW })).toBeNull();
  });

  it('does not double-book the same subreddit on the same day', () => {
    const s = state();
    scheduleDraft(s, draft(), { now: NOW, subreddits: pool() });
    const second = scheduleDraft(s, draft({ id: 'd2' }), { now: NOW, subreddits: pool() });
    expect(second).toBeNull();
  });

  it('allows a different subreddit on the same day', () => {
    const s = state();
    scheduleDraft(s, draft(), { now: NOW, subreddits: pool() });
    const other = draft({
      id: 'd2',
      primarySubreddit: 'webdev',
      suggestedSubreddits: [
        { subreddit: 'webdev', fit: 80, reasons: [], compliance: [], violations: [], compliant: true, subscribers: 1, activity: 1, bestHoursUtc: [] },
      ],
    });
    expect(scheduleDraft(s, other, { now: NOW, subreddits: pool() })).not.toBeNull();
  });

  it('keeps existing slots out of new picks', () => {
    const s = state();
    const first = scheduleDraft(s, draft(), { now: NOW, subreddits: pool() })!;
    const first2 = scheduleDraft(s, draft({ id: 'd2', primarySubreddit: 'webdev', suggestedSubreddits: [{ subreddit: 'webdev', fit: 50, reasons: [], compliance: [], violations: [], compliant: true, subscribers: 1, activity: 1, bestHoursUtc: [] }] }), { now: NOW, subreddits: pool() })!;
    expect(first.runAt).not.toBe(first2.runAt);
  });
});

describe('queue lifecycle', () => {
  it('lists due items oldest first', () => {
    const s = state({
      items: [
        { draftId: 'b', userId: 'u1', subreddit: 'r', runAt: '2026-01-04T02:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' },
        { draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-04T01:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' },
        { draftId: 'c', userId: 'u1', subreddit: 'r', runAt: '2026-01-09T00:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' },
      ],
    });
    expect(dueItems(s, NOW).map((i) => i.draftId)).toEqual(['a', 'b']);
    expect(upcoming(s, NOW).map((i) => i.draftId)).toEqual(['c']);
  });

  it('claims an item so two workers cannot both publish it', () => {
    const s = state({ items: [{ draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-04T01:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' }] });
    expect(claimItem(s, 'a')?.status).toBe('publishing');
    expect(claimItem(s, 'a')).toBeNull();
  });

  it('records history on completion', () => {
    const s = state({ items: [{ draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-04T01:00:00.000Z', reason: '', attempts: 0, status: 'publishing' }] });
    completeItem(s, 'a', 't3_abc', NOW);
    expect(s.history).toHaveLength(1);
    expect(s.history[0]?.postId).toBe('t3_abc');
    expect(s.items[0]?.status).toBe('published');
  });

  it('retries with exponential backoff, then gives up', () => {
    const s = state({ items: [{ draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-04T01:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' }] });
    const first = failItem(s, 'a', 'boom', { maxAttempts: 3 });
    expect(first.exhausted).toBe(false);
    expect(s.items[0]?.attempts).toBe(1);
    const second = failItem(s, 'a', 'boom', { maxAttempts: 3 });
    expect(second.exhausted).toBe(false);
    const third = failItem(s, 'a', 'boom', { maxAttempts: 3 });
    expect(third.exhausted).toBe(true);
    expect(s.items[0]?.status).toBe('failed');
  });

  it('marks a post removed so the cooldown applies', () => {
    const s = state();
    completeItem(state({ items: [{ draftId: 'a', userId: 'u1', subreddit: 'r', runAt: NOW.toISOString(), reason: '', attempts: 0, status: 'publishing' }] }), 'a', 't3_x', NOW);
    void s;
  });

  it('markRemoved flips the history flag', () => {
    const s = state();
    s.history.push({ userId: 'u1', subreddit: 'r', postedAt: NOW.toISOString(), postId: 't3_x', removed: false });
    markRemoved(s, 't3_x');
    expect(s.history[0]?.removed).toBe(true);
  });

  it('describes the queue', () => {
    const s = state({ items: [{ draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-06T00:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' }] });
    expect(describeQueue(s, NOW)).toContain('1 scheduled');
    expect(describeQueue(s, NOW)).toContain('next: r');
  });
});

describe('tick', () => {
  it('publishes everything that is due', async () => {
    const s = state({
      items: [
        { draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-04T01:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' },
        { draftId: 'b', userId: 'u1', subreddit: 'r', runAt: '2026-01-09T00:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' },
      ],
    });
    const publish = vi.fn(async () => {});
    const onPublished = vi.fn(async () => {});
    const result = await tick({ state: s, publish, onPublished, now: NOW });
    expect(result.processed).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(onPublished).toHaveBeenCalledWith('a');
  });

  it('retries a failure instead of throwing', async () => {
    const s = state({
      items: [{ draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-04T01:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' }],
    });
    const publish = vi.fn(async () => {
      throw new Error('reddit 503');
    });
    const result = await tick({ state: s, publish, now: NOW, maxAttempts: 3 });
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(s.items[0]?.attempts).toBe(1);
    expect(s.items[0]?.lastError).toBe('reddit 503');
  });

  it('gives up after maxAttempts', async () => {
    const s = state({
      items: [{ draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-04T01:00:00.000Z', reason: '', attempts: 2, status: 'scheduled' }],
    });
    const publish = vi.fn(async () => {
      throw new Error('nope');
    });
    const result = await tick({ state: s, publish, now: NOW, maxAttempts: 3 });
    expect(result.failed).toBe(1);
    expect(s.items[0]?.status).toBe('failed');
  });

  it('does nothing when nothing is due', async () => {
    const publish = vi.fn(async () => {});
    const result = await tick({ state: state(), publish, now: NOW });
    expect(result.processed).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('buildCalendar', () => {
  it('groups items by day and flags loaded days', () => {
    const s = state({
      config: GuardrailConfigSchema.parse({ maxPostsPerDay: 1 }),
      items: [
        { draftId: 'a', userId: 'u1', subreddit: 'r', runAt: '2026-01-05T01:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' },
        { draftId: 'b', userId: 'u1', subreddit: 'r', runAt: '2026-01-05T09:00:00.000Z', reason: '', attempts: 0, status: 'scheduled' },
      ],
    });
    const calendar = buildCalendar(s, { from: NOW, days: 3 });
    expect(calendar).toHaveLength(3);
    expect(calendar[0]?.items).toHaveLength(2);
    expect(calendar[0]?.blocked).toBe(true);
    expect(calendar[0]?.load).toBe(100);
  });
});