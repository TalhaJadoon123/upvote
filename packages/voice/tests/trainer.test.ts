import { describe, expect, it } from 'vitest';
import { scoreAuthenticity, type VoiceSample } from '@upvote/core';
import {
  adjustProfile,
  assessQuality,
  balanceSamples,
  cleanRedditText,
  deduplicateSamples,
  deriveBannedWords,
  describeProfile,
  describeSources,
  extractEmojiFavorites,
  extractOpenersAndClosers,
  extractSignaturePhrases,
  extractVocabulary,
  mergeTeamProfiles,
  sampleFromManualText,
  samplesFromBlogPosts,
  samplesFromCommits,
  samplesFromRedditListing,
  samplesFromReadme,
  samplesFromTweets,
  trainVoiceProfile,
} from '@upvote/voice';

const CASUAL: VoiceSample[] = [
  {
    id: '1',
    source: 'reddit_post',
    score: 300,
    text: `i rewrote the ingest layer last weekend. it should have taken an hour.

the bug was a retry loop that cached its own failures. embarrassing. the fix was deleting eleven lines.

lesson: when the smart optimization is the thing that keeps firing, it is usually the bug.`,
  },
  {
    id: '2',
    source: 'reddit_post',
    score: 120,
    text: `ok so i finally shipped the thing.

honestly the boring version first and the fun part later works every time. the boring version is always the right call.`,
  },
  {
    id: '3',
    source: 'reddit_comment',
    score: 40,
    text: `yeah that won't work at scale. i tried it, the connection pool melts.

what i did instead was batch the writes and drop the transaction boundary. boring beats clever every time.`,
  },
  {
    id: '4',
    source: 'reddit_comment',
    score: 9,
    text: `this matches my experience. the docs are wrong about the default timeout btw.`,
  },
];

describe('trainVoiceProfile', () => {
  it('builds a usable profile from four samples', () => {
    const { profile } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    expect(profile.id).toMatch(/^vp_/);
    expect(profile.sampleCount).toBe(4);
    expect(profile.favoriteWords.length).toBeGreaterThan(0);
    expect(profile.embedding.length).toBe(192);
    expect(profile.vector.formality).toBeLessThan(1);
  });

  it('captures recurring phrasing as signature phrases', () => {
    const { profile } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    expect(profile.signaturePhrases.length).toBeGreaterThan(0);
    const all = profile.signaturePhrases.join(' | ');
    expect(all).toContain('boring');
  });

  it('derives banned words from AI tells the founder never uses', () => {
    const banned = deriveBannedWords(CASUAL);
    expect(banned).toContain('delve');
    expect(banned).not.toContain('boring');
  });

  it('scores the founder writing above a stranger writing', () => {
    const { profile } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    const own = scoreAuthenticity(
      'the boring version first and the clever version later. embarrassing lesson, learned it the expensive way.',
      profile,
    );
    const stranger = scoreAuthenticity(
      'Our platform leverages a comprehensive ecosystem to unlock seamless productivity gains for modern teams.',
      profile,
    );
    expect(own.score).toBeGreaterThan(stranger.score + 25);
  });

  it('throws a useful error when there is nothing to learn from', () => {
    expect(() => trainVoiceProfile([], { userId: 'u1' })).toThrow(/no usable samples/i);
    expect(() => trainVoiceProfile([{ id: '1', source: 'commit', text: 'ok' }], { userId: 'u1' })).toThrow();
  });

  it('honours manual settings overrides', () => {
    const { profile } = trainVoiceProfile(CASUAL, {
      userId: 'u1',
      formalityOverride: 0.1,
      humorOverride: 0.9,
      ctaStyle: 'none',
      profanityAllowed: true,
      bannedPhrases: ['acme'],
    });
    expect(profile.settings.formality).toBe(0.1);
    expect(profile.settings.humor).toBe(0.9);
    expect(profile.settings.ctaStyle).toBe('none');
    expect(profile.settings.bannedPhrases).toContain('acme');
  });

  it('is deterministic', () => {
    const a = trainVoiceProfile(CASUAL, { userId: 'u1' });
    const b = trainVoiceProfile(CASUAL, { userId: 'u1' });
    expect(a.profile.vector).toEqual(b.profile.vector);
    expect(a.profile.favoriteWords).toEqual(b.profile.favoriteWords);
  });

  it('produces a readable description', () => {
    const { profile } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    const description = describeProfile(profile);
    expect(description).toMatch(/words\/sentence/);
    expect(description).toContain('4 samples');
  });
});

describe('assessQuality', () => {
  it('flags a thin corpus', () => {
    const { quality } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    expect(quality.readyForProduction).toBe(false);
    expect(quality.warnings.length).toBeGreaterThan(0);
    expect(quality.score).toBeLessThan(70);
  });

  it('reaches production readiness with a large multi-source corpus', () => {
    const many: VoiceSample[] = [];
    for (let i = 0; i < 20; i++) {
      many.push({ id: `p${i}`, source: 'reddit_post', score: 10, text: CASUAL[0]!.text });
      many.push({ id: `c${i}`, source: 'reddit_comment', score: 5, text: CASUAL[2]!.text });
      many.push({ id: `t${i}`, source: 'tweet', score: 2, text: `the boring version first, tweet number ${i} about shipping things honestly` });
    }
    const { quality } = trainVoiceProfile(many, { userId: 'u1' });
    expect(quality.readyForProduction).toBe(true);
    expect(Object.keys(quality.bySource).length).toBeGreaterThanOrEqual(3);
  });

  it('counts words across the corpus', () => {
    const { quality } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    expect(quality.words).toBeGreaterThan(100);
  });
});

describe('extractVocabulary', () => {
  it('ranks identity words above common ones', () => {
    const { favorite } = extractVocabulary(CASUAL);
    const joined = favorite.join(' ');
    expect(joined).toMatch(/ingest|retry|boring|embarrassing|clever/);
  });

  it('excludes stopwords and digits', () => {
    const { favorite } = extractVocabulary(CASUAL);
    expect(favorite).not.toContain('the');
    expect(favorite.every((w) => !/^\d+$/.test(w))).toBe(true);
  });
});

describe('extractSignaturePhrases', () => {
  it('finds phrases that recur across samples', () => {
    const phrases = extractSignaturePhrases(CASUAL);
    expect(phrases.some((p) => p.includes('boring'))).toBe(true);
  });

  it('returns nothing when no phrase repeats', () => {
    expect(extractSignaturePhrases([{ id: '1', source: 'commit', text: 'a completely unique sentence about nothing at all here' }])).toEqual([]);
  });

  it('never starts or ends a phrase on a function word', () => {
    for (const phrase of extractSignaturePhrases(CASUAL)) {
      expect(phrase.split(' ')[0]).not.toBe('the');
    }
  });
});

describe('emoji, openers and closers', () => {
  it('collects emoji favorites by frequency', () => {
    const samples: VoiceSample[] = [
      { id: '1', source: 'tweet', text: 'shipped it 🚀 and then again 🚀', score: 1 },
      { id: '2', source: 'tweet', text: 'one more 💡 for the road', score: 1 },
    ];
    expect(extractEmojiFavorites(samples)[0]).toBe('🚀');
  });

  it('extracts openers and closers from prose sources only', () => {
    const { openers, closers } = extractOpenersAndClosers(CASUAL);
    expect(openers.length).toBeGreaterThan(0);
    expect(closers.length).toBeGreaterThan(0);
    expect(openers.some((o) => o.startsWith('i rewrote'))).toBe(true);
  });
});

describe('adjustProfile', () => {
  it('changes settings without touching the learned vector', () => {
    const { profile } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    const before = { ...profile.vector };
    const adjusted = adjustProfile(profile, { formality: 0.9, ctaStyle: 'direct' });
    expect(adjusted.settings.formality).toBe(0.9);
    expect(adjusted.settings.ctaStyle).toBe('direct');
    expect(adjusted.vector).toEqual(before);
  });

  it('clamps out-of-range values and extends the banned list', () => {
    const { profile } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    const adjusted = adjustProfile(profile, { formality: 5, humor: -3, bannedWords: ['synergy'] });
    expect(adjusted.settings.formality).toBe(1);
    expect(adjusted.settings.humor).toBe(0);
    expect(adjusted.bannedWords).toContain('synergy');
  });
});

describe('mergeTeamProfiles', () => {
  it('averages the vector and unions the lexicons', () => {
    const a = trainVoiceProfile(CASUAL, { userId: 'u1' }).profile;
    const b = trainVoiceProfile(
      [
        { id: 'x', source: 'reddit_post', score: 5, text: 'the elegant approach beat the clever one. quiet, deliberate, small changes compound over time and it shows.' },
      ],
      { userId: 'u2' },
    ).profile;
    const team = mergeTeamProfiles([a, b], { userId: 'team' });
    expect(team.sampleCount).toBe(a.sampleCount + b.sampleCount);
    expect(team.favoriteWords.length).toBeGreaterThanOrEqual(a.favoriteWords.length);
    expect(team.bannedWords).toEqual(expect.arrayContaining(['delve']));
  });

  it('refuses to merge nothing', () => {
    expect(() => mergeTeamProfiles([], { userId: 't' })).toThrow();
  });
});

describe('source adapters', () => {
  it('parses a mixed Reddit listing', () => {
    const samples = samplesFromRedditListing([
      { kind: 't3', data: { id: 'a1', title: 'I rewrote the ingest layer last weekend', selftext: 'the retry loop cached its own failures, embarrassing.', score: 12 } },
      { kind: 't1', data: { id: 'c1', body: 'this matches my experience, the docs are wrong about the timeout', score: 4 } },
      { kind: 't1', data: { id: 'c2', body: 'too short' } },
    ]);
    expect(samples).toHaveLength(2);
    expect(samples[0]?.source).toBe('reddit_post');
    expect(samples[1]?.source).toBe('reddit_comment');
  });

  it('cleans Reddit markdown artefacts', () => {
    const cleaned = cleanRedditText(
      'Edit: typo\n\n> quoted\n\nsee [the docs](https://x.com) and r/programming for more, u/someone asked.',
    );
    expect(cleaned).not.toContain('Edit:');
    expect(cleaned).not.toContain('quoted');
    expect(cleaned).toContain('the docs');
  });

  it('strips conventional-commit prefixes', () => {
    const samples = samplesFromCommits([
      { sha: 'abc', commit: { message: 'fix: stop the retry loop from caching failures\n\neleven lines deleted', author: { name: 'dev', date: '2026-01-01T00:00:00Z' } } },
      { sha: 'def', commit: { message: 'tiny' } },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.text.startsWith('stop the retry')).toBe(true);
  });

  it('builds samples from a repo description and README', () => {
    const samples = samplesFromReadme(
      { full_name: 'acme/tool', description: 'a tiny cli that wraps the release notes command' },
      '# Tool\n\n```sh\nnpm i\n```\n\nIt wraps the release notes command so you do not have to remember the flags every time you ship.',
    );
    expect(samples.length).toBe(2);
    expect(samples.every((s) => s.source === 'readme')).toBe(true);
    expect(samples[1]!.text).not.toContain('npm i');
  });

  it('strips URLs out of tweets and keeps engagement as score', () => {
    const samples = samplesFromTweets([
      { id_str: '1', full_text: 'shipped the rewrite today https://t.co/abc', favorite_count: 9, retweet_count: 3 },
      { id_str: '2', full_text: 'short' },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.text).not.toContain('https');
    expect(samples[0]?.score).toBe(12);
  });

  it('requires substantive blog posts', () => {
    const samples = samplesFromBlogPosts([
      { id: '1', title: 'Postmortem', content: `<p>${'the system failed for three hours and nobody noticed because the alert was wrong. '.repeat(4)}</p>` },
      { id: '2', title: 'Hi', content: '<p>hi</p>' },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.text).toContain('Postmortem');
  });

  it('creates a manual sample only when long enough', () => {
    expect(sampleFromManualText('u1', 'short')).toBeNull();
    expect(sampleFromManualText('u1', 'a long enough manual sample of writing to learn from')).not.toBeNull();
  });

  it('describes the source mix', () => {
    expect(describeSources(CASUAL)).toMatch(/reddit post/);
    expect(describeSources(CASUAL)).toMatch(/reddit comment/);
  });
});

describe('balanceSamples', () => {
  it('caps noisy sources and keeps the best-performing ones', () => {
    const commits = Array.from({ length: 200 }, (_, i) => ({
      id: `c${i}`,
      source: 'commit' as const,
      text: `fix: retry loop caching failure number ${i} with a decent amount of text`,
      score: 0,
    }));
    const balanced = balanceSamples([...CASUAL, ...commits]);
    const commitCount = balanced.filter((s) => s.source === 'commit').length;
    expect(commitCount).toBeLessThanOrEqual(80);
    expect(balanced.filter((s) => s.source === 'reddit_post')).toHaveLength(2);
  });
});

describe('deduplicateSamples', () => {
  it('drops near-identical samples', () => {
    const text = 'i rewrote the ingest layer last weekend it should have taken an hour indeed';
    const deduped = deduplicateSamples([
      { id: '1', source: 'reddit_post', text },
      { id: '2', source: 'reddit_post', text: text.toUpperCase() },
      { id: '3', source: 'reddit_post', text: 'a completely different sentence entirely here' },
    ]);
    expect(deduped).toHaveLength(2);
  });
});

describe('assessQuality direct', () => {
  it('accepts an explicit vector', () => {
    const { profile } = trainVoiceProfile(CASUAL, { userId: 'u1' });
    const quality = assessQuality(CASUAL, profile.vector);
    expect(quality.score).toBeGreaterThan(0);
    expect(quality.sampleCount).toBe(CASUAL.length);
  });
});
