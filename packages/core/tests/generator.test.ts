import { describe, expect, it } from 'vitest';
import {
  aggregateStyle,
  buildSystemPrompt,
  buildUserPrompt,
  clientFromEnv,
  createStaticClient,
  generateDraftSet,
  hashedEmbedding,
  momentFromText,
  parseDraftResponse,
  styleBiasFromResults,
  suggestReply,
  VoiceProfileSchema,
  type ShippingMoment,
  type VoiceProfile,
  type VoiceSample,
} from '@upvote/core';

const SAMPLES: VoiceSample[] = [
  {
    id: '1',
    source: 'reddit_post',
    score: 200,
    text: `i rewrote the ingest layer last weekend. it should have taken an hour.

the bug was a retry loop that cached its own failures. embarrassing. the fix was deleting eleven lines.

lesson: when the "smart" optimization is the thing that keeps firing, it's usually the bug.`,
  },
  {
    id: '2',
    source: 'reddit_post',
    score: 90,
    text: `ok so i finally shipped the thing.

honestly the boring version first and the fun part later works every time. i keep learning this the expensive way lol`,
  },
  {
    id: '3',
    source: 'reddit_comment',
    score: 20,
    text: `yeah that won't work at scale. i tried it, the connection pool melts.

what i did instead was batch the writes and drop the transaction boundary.`,
  },
];

function profile(): VoiceProfile {
  const { vector, variance } = aggregateStyle(SAMPLES);
  return VoiceProfileSchema.parse({
    id: 'vp1',
    userId: 'u1',
    sampleCount: SAMPLES.length,
    vector,
    variance,
    signaturePhrases: ['it should have taken an hour', 'the boring version first'],
    favoriteWords: ['ingest', 'retry', 'boring', 'embarrassing', 'shipped'],
    bannedWords: ['delve', 'synergy'],
    embedding: hashedEmbedding(SAMPLES.map((s) => s.text).join('\n\n')),
  });
}

const MOMENT: ShippingMoment = {
  id: 'mom1',
  kind: 'release',
  title: 'v2.0.0 - ingest rewrite',
  body: 'replaced the retry loop, dropped the cache layer, 11 files changed',
  whatChanged: 'the retry loop no longer caches its own failures',
  lesson: 'when the smart optimization keeps firing, it is usually the bug',
  tags: ['python', 'postgres', 'backend'],
  source: { repo: 'acme/ingest', commitCount: 11 },
  createdAt: '2026-01-05T10:00:00.000Z',
};

describe('clientFromEnv', () => {
  it('returns null when no provider is configured', () => {
    expect(clientFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('respects UPVOTE_OFFLINE even when a key is present', () => {
    // This is what keeps the test suite from making billed network calls.
    expect(
      clientFromEnv({ OPENAI_API_KEY: 'sk-real-key', UPVOTE_OFFLINE: '1' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('builds a client when a key is configured', () => {
    expect(clientFromEnv({ OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv)?.name).toContain('gpt');
  });
});

describe('generateDraftSet', () => {
  it('produces one draft per style, each voice-scored', async () => {
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      minAuthenticity: 40,
    });
    expect(set.drafts.length).toBe(4);
    expect(set.momentId).toBe('mom1');
    for (const draft of set.drafts) {
      expect(draft.authenticityScore).toBeGreaterThan(0);
      expect(draft.title.length).toBeGreaterThan(3);
      expect(draft.body.length).toBeGreaterThan(30);
      expect(draft.titleVariants.length).toBeGreaterThanOrEqual(1);
      expect(draft.suggestedSubreddits.length).toBeGreaterThan(0);
    }
  });

  it('sorts drafts by authenticity descending', async () => {
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      minAuthenticity: 30,
    });
    const scores = set.drafts.map((d) => d.authenticityScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('works with no model configured (offline composer)', async () => {
    const set = await generateDraftSet(MOMENT, { userId: 'u1', profile: profile(), minAuthenticity: 20 });
    expect(set.drafts[0]?.generator.model).toBe('offline-composer');
  });

  it('uses a model when one is supplied and parses JSON', async () => {
    const model = createStaticClient([
      JSON.stringify({
        title: 'i deleted eleven lines and the retry bug disappeared',
        titleVariants: ['eleven lines gone', 'the retry cache was the bug', 'worst cache decision ever'],
        body: 'i rewrote the ingest layer last weekend. it should have taken an hour.\n\nthe retry loop was caching its own failures. embarrassing. deleting it fixed everything.\n\nthe boring version first, always.',
        firstComment: 'eleven lines. that is the whole fix.',
      }),
    ]);
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      model,
      minAuthenticity: 30,
      styles: ['show_and_tell'],
    });
    expect(set.drafts.length).toBe(1);
    expect(set.drafts[0]?.title).toContain('eleven lines');
    expect(set.drafts[0]?.generator.model).toBe('static');
  });

  it('skips the comment-reply style when no thread context exists', async () => {
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      minAuthenticity: 20,
    });
    expect(set.rejected.some((r) => r.style === 'comment_reply' && /thread context/i.test(r.reason))).toBe(true);
  });

  it('generates a comment reply when a thread is supplied', async () => {
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      minAuthenticity: 10,
      styles: ['comment_reply'],
      parentComment: { author: 'dev_dan', body: 'how are you batching the writes?' },
      threadTitle: 'my ingest rewrite',
    });
    expect(set.drafts).toHaveLength(1);
    expect(set.drafts[0]?.style).toBe('comment_reply');
    expect(set.drafts[0]?.body.length).toBeGreaterThan(10);
  });

  it('falls back to the offline composer when the model returns junk', async () => {
    const model = createStaticClient(['I cannot help with that request.']);
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      model,
      minAuthenticity: 20,
      styles: ['story'],
    });
    expect(set.drafts.length).toBe(1);
    expect(set.drafts[0]?.body.length).toBeGreaterThan(30);
  });

  it('rejects rather than shipping a draft under the threshold', async () => {
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      minAuthenticity: 99.9,
      maxAttempts: 1,
      styles: ['story'],
    });
    expect(set.drafts).toHaveLength(0);
    expect(set.rejected).toHaveLength(1);
    expect(set.rejected[0]?.reason).toMatch(/never reached/);
  });

  it('honours the limit', async () => {
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      minAuthenticity: 20,
      limit: 2,
    });
    expect(set.drafts.length).toBeLessThanOrEqual(2);
  });

  it('schedules into a subreddit the draft is compliant with', async () => {
    const set = await generateDraftSet(MOMENT, {
      userId: 'u1',
      profile: profile(),
      minAuthenticity: 20,
      styles: ['question'],
    });
    const draft = set.drafts[0]!;
    expect(draft.primarySubreddit).toBeTruthy();
    expect(draft.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is deterministic for the same seed', async () => {
    const a = await generateDraftSet(MOMENT, { userId: 'u1', profile: profile(), minAuthenticity: 20, seed: 's1' });
    const b = await generateDraftSet(MOMENT, { userId: 'u1', profile: profile(), minAuthenticity: 20, seed: 's1' });
    expect(a.drafts.map((d) => d.body)).toEqual(b.drafts.map((d) => d.body));
  });
});

describe('prompt construction', () => {
  it('injects the voice profile into the system prompt', () => {
    const system = buildSystemPrompt(profile());
    expect(system).toMatch(/sentences averaging ~\d+ words/);
    expect(system).toContain('it should have taken an hour');
    expect(system).toMatch(/STRICT JSON/);
    expect(system.toLowerCase()).toContain('no corporate speak');
  });

  it('includes the raw signal and the repair directives', () => {
    const prompt = buildUserPrompt(MOMENT, 'question', {
      directives: ['Shorten paragraphs.'],
    });
    expect(prompt).toContain('ingest rewrite');
    expect(prompt).toContain('python, postgres');
    expect(prompt).toContain('Shorten paragraphs.');
    expect(prompt).toMatch(/POST STYLE: Question/);
  });

  it('tells the model not to link in replies', () => {
    const prompt = buildUserPrompt(MOMENT, 'comment_reply', {
      parentComment: { author: 'someone', body: 'how do you batch this?' },
      threadTitle: 'batching writes',
    });
    expect(prompt).toContain('REPLYING IN A THREAD');
    expect(prompt).toContain('u/someone');
  });
});

describe('parseDraftResponse', () => {
  it('parses clean JSON', () => {
    const parsed = parseDraftResponse('{"title":"a","titleVariants":["a","b"],"body":"body text here","firstComment":"hi"}');
    expect(parsed.title).toBe('a');
    expect(parsed.body).toBe('body text here');
    expect(parsed.titleVariants).toEqual(['a', 'b']);
  });

  it('parses fenced JSON', () => {
    const parsed = parseDraftResponse('```json\n{"title":"t","body":"b"}\n```');
    expect(parsed.title).toBe('t');
  });

  it('extracts JSON from surrounding prose', () => {
    const parsed = parseDraftResponse('Here you go: {"title":"t","body":"b"} hope that helps!');
    expect(parsed.body).toBe('b');
  });

  it('degrades to plain text when there is no JSON', () => {
    const parsed = parseDraftResponse('i deleted the cache layer and everything worked');
    expect(parsed.body).toContain('deleted the cache layer');
    expect(parsed.title.length).toBeGreaterThan(0);
  });

  it('derives a title from the first line when the model omits one', () => {
    const parsed = parseDraftResponse('{"body":"# Real Title\n\nrest of it"}');
    expect(parsed.title).toBe('Real Title');
  });

  it('recovers fields from malformed JSON containing raw newlines', () => {
    const parsed = parseDraftResponse(
      '{"body":"# The Title' + '\n\n' + 'first paragraph' + '\n\n' + 'second paragraph"}',
    );
    expect(parsed.title).toBe('The Title');
    expect(parsed.body).toContain('second paragraph');
  });
});

describe('momentFromText', () => {
  it('splits a lesson line out of free text', () => {
    const moment = momentFromText(
      'fixed the retry cache\n\nthe cache was storing its own failures\nLesson: boring solutions beat clever ones',
      ['python'],
    );
    expect(moment.kind).toBe('manual');
    expect(moment.lesson).toBe('boring solutions beat clever ones');
    expect(moment.body).not.toContain('Lesson:');
    expect(moment.tags).toEqual(['python']);
  });

  it('handles a single line', () => {
    const moment = momentFromText('just shipped the thing');
    expect(moment.title).toBe('just shipped the thing');
    expect(moment.id).toMatch(/^mom_/);
  });
});

describe('suggestReply', () => {
  it('produces a short reply in the founder voice', async () => {
    const result = await suggestReply(
      { author: 'curious_dev', body: 'how are you handling the batch size at scale?' },
      { title: 'my ingest rewrite', subreddit: 'programming' },
      profile(),
    );
    expect(result.reply.length).toBeGreaterThan(20);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reply.split('\n\n').length).toBeLessThanOrEqual(4);
  });

  it('uses the model when provided', async () => {
    const model = createStaticClient(['batch size depends on the p99 not the average, i learned that the hard way']);
    const result = await suggestReply(
      { author: 'x', body: 'batch size?' },
      { title: 't', subreddit: 'programming' },
      profile(),
      { model },
    );
    expect(result.reply).toContain('p99');
  });
});

describe('styleBiasFromResults', () => {
  it('returns subreddit-level multipliers in 0-1', () => {
    const bias = styleBiasFromResults([
      { subreddit: 'webdev', style: 'story', engagement: 90 },
      { subreddit: 'webdev', style: 'story', engagement: 10 },
      { subreddit: 'SaaS', style: 'data', engagement: 5 },
    ]);
    expect(bias.webdev).toBeGreaterThan(bias.SaaS!);
    expect(bias.webdev).toBeLessThanOrEqual(1);
    expect(bias.SaaS).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty map when there is no engagement yet', () => {
    expect(styleBiasFromResults([])).toEqual({});
  });
});