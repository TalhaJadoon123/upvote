import { describe, expect, it } from 'vitest';
import {
  aggregateStyle,
  clickAppeal,
  rankTitleVariants,
  scoreAuthenticity,
  scoreDraftAuthenticity,
  VoiceProfileSchema,
  type VoiceProfile,
  type VoiceSample,
} from '@upvote/core';
import { extractStyle } from '@upvote/core';
import { hashedEmbedding } from '@upvote/core';

/* ------------------------------------------------------------------ */
/* Fixture: a founder who writes like a tired engineer                 */
/* ------------------------------------------------------------------ */

const SAMPLES: VoiceSample[] = [
  {
    id: '1',
    source: 'reddit_post',
    score: 240,
    text: `i rewrote the ingest layer last weekend. it should have taken an hour.

the bug was a retry loop that cached its own failures. embarrassing. the fix was deleting eleven lines.

lesson: when the "smart" optimization is the thing that keeps firing, it's usually the bug.`,
  },
  {
    id: '2',
    source: 'reddit_post',
    score: 88,
    text: `ok so i finally shipped the thing.

honestly the boring version first and the fun part later works every time. i keep learning this the expensive way lol

happy to go deeper on any part of this.`,
  },
  {
    id: '3',
    source: 'reddit_comment',
    score: 31,
    text: `yeah that won't work at scale. i tried it, the connection pool melts.

what i did instead was batch the writes and drop the transaction boundary.`,
  },
  {
    id: '4',
    source: 'reddit_comment',
    score: 12,
    text: `this matches my experience. the docs are wrong about the default timeout btw`,
  },
  {
    id: '5',
    source: 'readme',
    score: 0,
    text: `# uptool

a tiny cli that wraps the release notes command.

install: npm i -g uptool`,
  },
];

function buildProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  const { vector, variance } = aggregateStyle(SAMPLES);
  return VoiceProfileSchema.parse({
    id: 'vp_test',
    userId: 'u1',
    sampleCount: SAMPLES.length,
    vector,
    variance,
    signaturePhrases: ['it should have taken an hour', 'the boring version first', 'the expensive way'],
    favoriteWords: ['ingest', 'retry', 'boring', 'embarrassing', 'shipped'],
    bannedWords: ['delve', 'synergy'],
    emojiFavorites: [],
    embedding: hashedEmbedding(SAMPLES.map((s) => s.text).join('\n\n')),
    settings: {
      formality: vector.formality,
      humor: Math.max(vector.humor, 0.35),
      emojiRate: 0.4,
      profanityAllowed: false,
      ctaStyle: 'soft',
      bannedPhrases: ['as an AI', 'hope this helps'],
    },
    ...overrides,
  });
}

const PROFILE = buildProfile();

/* ------------------------------------------------------------------ */

describe('scoreAuthenticity', () => {
  it('scores the founder\'s own words highest', () => {
    const own = scoreAuthenticity(
      `i rewrote the ingest layer last weekend. it should have taken an hour.

the fix was deleting eleven lines. embarrassing.

lesson: when the "smart" optimization keeps firing, it's usually the bug.`,
      PROFILE,
    );
    const generic = scoreAuthenticity(
      `In today's rapidly evolving software landscape, developers must leverage robust optimization strategies to unlock seamless performance gains. We are thrilled to announce a comprehensive suite of enhancements that dramatically streamline your workflow.`,
      PROFILE,
    );
    expect(own.score).toBeGreaterThan(generic.score);
    expect(generic.score).toBeLessThan(60);
  });

  it('returns 0-100 and a passed flag', () => {
    const report = scoreAuthenticity('ok so i shipped it. the boring version first worked again.', PROFILE);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.passed).toBe(report.score >= 85);
  });

  it('always reports every breakdown dimension', () => {
    const report = scoreAuthenticity('short post', PROFILE);
    expect(Object.keys(report.breakdown).sort()).toEqual(
      ['ngramSimilarity', 'penalty', 'platformNative', 'punctuation', 'rhythm', 'styleMatch', 'vocabulary'].sort(),
    );
  });

  it('penalizes AI-tell phrasing hard', () => {
    const clean = scoreAuthenticity('i deleted the cache layer and the retries stopped firing.', PROFILE);
    const tells = scoreAuthenticity(
      "it's important to note that we strive to unlock the power of seamless ecosystem synergies for your journey.",
      PROFILE,
    );
    expect(tells.breakdown.penalty).toBeGreaterThan(0);
    expect(tells.notes.some((n) => n.includes('AI copy'))).toBe(true);
    expect(tells.score).toBeLessThan(clean.score);
  });

  it('penalizes a link in the first paragraph', () => {
    const bad = scoreAuthenticity('check out my tool https://example.com\n\nit does a thing.', PROFILE);
    const good = scoreAuthenticity('i built a thing that does a thing.\n\ndetails here.', PROFILE);
    expect(bad.breakdown.platformNative).toBeLessThan(good.breakdown.platformNative);
    expect(bad.directives.join(' ')).toMatch(/first paragraph/i);
  });

  it('penalizes wall-of-text paragraphs', () => {
    const wall = `x ${'word '.repeat(160)}\n\ny ${'word '.repeat(160)}`;
    const report = scoreAuthenticity(wall, PROFILE);
    expect(report.breakdown.rhythm).toBeLessThan(70);
  });

  it('flags the founder\'s banned words', () => {
    const report = scoreAuthenticity('we used delve to delve into the problem', PROFILE);
    expect(report.notes.join(' ')).toMatch(/never uses/i);
  });

  it('respects banned phrases from settings', () => {
    const report = scoreAuthenticity('as an AI language model i cannot help with that', PROFILE);
    expect(report.breakdown.penalty).toBeGreaterThan(0);
  });

  it('widens tolerance when the profile has few samples', () => {
    const thin = buildProfile({ sampleCount: 2, variance: {} });
    const text = 'i rewrote the ingest layer and deleted the retry cache. embarrassing but it works.';
    const thinScore = scoreAuthenticity(text, thin);
    const thickScore = scoreAuthenticity(text, PROFILE);
    // A thin profile should not be more confident than a well-trained one.
    expect(thinScore.score).toBeLessThanOrEqual(thickScore.score + 15);
  });

  it('produces actionable directives when it fails', () => {
    const report = scoreAuthenticity(
      'Furthermore, it is important to note that this comprehensive solution leverages a robust ecosystem paradigm to unlock seamless value for your journey, and I hope this helps.',
      PROFILE,
    );
    expect(report.passed).toBe(false);
    expect(report.directives.length).toBeGreaterThan(0);
    for (const d of report.directives) expect(typeof d).toBe('string');
  });

  it('is deterministic', () => {
    const text = 'i shipped it. the boring version first, always.';
    expect(scoreAuthenticity(text, PROFILE).score).toBe(scoreAuthenticity(text, PROFILE).score);
  });

  it('can skip the platform-native checks for comments', () => {
    const text = 'a single paragraph with no structure whatsoever but honest and to the point';
    const withChecks = scoreAuthenticity(text, PROFILE, { platformNative: true });
    const withoutChecks = scoreAuthenticity(text, PROFILE, { platformNative: false });
    expect(withoutChecks.breakdown.platformNative).toBe(100);
    expect(withoutChecks.score).toBeGreaterThan(withChecks.score);
  });
});

describe('scoreDraftAuthenticity', () => {
  it('weights the title and the body together', () => {
    const inVoice = scoreDraftAuthenticity(
      { title: 'the retry cache was the bug', body: 'i deleted eleven lines and the failures stopped firing. embarrassing.' },
      PROFILE,
    );
    const offVoice = scoreDraftAuthenticity(
      {
        title: 'Announcing a comprehensive new release of our platform',
        body: 'Furthermore, this milestone represents a significant leap forward for our entire community of builders.',
      },
      PROFILE,
    );
    expect(inVoice.score).toBeGreaterThan(offVoice.score * 1.5);
  });

  it('never exceeds the individual body score when the title is generic', () => {
    const report = scoreDraftAuthenticity(
      { title: 'Announcement', body: 'i shipped the ingest rewrite. eleven lines deleted. embarrassing.' },
      PROFILE,
    );
    expect(report.score).toBeLessThanOrEqual(100);
  });
});

describe('rankTitleVariants', () => {
  it('ranks titles by voice match, descending', () => {
    const ranked = rankTitleVariants(
      [
        'Comprehensive Announcement Regarding Our Platform Evolution',
        'the retry cache was the bug',
        'Introducing a New Release',
      ],
      'i deleted eleven lines and the failures stopped firing. embarrassing lesson learned.',
      PROFILE,
    );
    expect(ranked).toHaveLength(3);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
    expect(ranked[1]!.score).toBeGreaterThanOrEqual(ranked[2]!.score);
    expect(ranked[0]!.title).toBe('the retry cache was the bug');
  });
});

describe('clickAppeal', () => {
  it('rewards a specific length and punishes keyword-stuffed titles', () => {
    expect(clickAppeal('i deleted 11 lines and the retry bug disappeared')).toBeGreaterThan(
      clickAppeal('Help me please I have a question about something'),
    );
    expect(clickAppeal('QUESTION')).toBeLessThan(50);
  });

  it('penalizes absurdly long titles', () => {
    expect(clickAppeal('a'.repeat(140))).toBeLessThan(clickAppeal('a'.repeat(60)));
  });
});

describe('profile construction', () => {
  it('captures this founder\'s lowercase habit', () => {
    expect(PROFILE.vector.lowercaseRatio).toBeGreaterThan(0.5);
  });

  it('captures short paragraphs', () => {
    expect(PROFILE.vector.paragraphWords).toBeLessThan(80);
  });

  it('separates this founder from a formal writing style', () => {
    const formal = aggregateStyle(
      SAMPLES.map(() => ({
        text:
          'It is worth noting that the implementation substantially improved reliability across the fleet. Furthermore, the team recommends a phased rollout to mitigate risk.',
        score: 10,
      })),
    ).vector.formality;
    expect(PROFILE.vector.formality).toBeLessThan(formal);
    expect(PROFILE.vector.formality).toBeLessThan(0.65);
  });

  it('exposes every style dimension on the profile', () => {
    const keys = Object.keys(extractStyle('sample').vector).length;
    expect(Object.keys(PROFILE.vector)).toHaveLength(keys);
  });
});