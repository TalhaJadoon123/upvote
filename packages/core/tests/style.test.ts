import { describe, expect, it } from 'vitest';
import {
  aggregateStyle,
  countAiTells,
  extractStyle,
  type StyleVector,
} from '@upvote/core';
import type { VoiceSample } from '@upvote/core';

const CASUAL_SAMPLES = [
  'ok so i finally shipped the thing. took way longer than it should have.',
  'tldr: the rewrite fixed it. not sure why i waited so long honestly lol',
  'spent 3 days on this. the actual fix was 20 lines. wild',
  'honestly this would have taken an hour if i had read the docs',
  'it works! the boring version first, the fun part later. always the same.',
];

function samples(texts: string[], source: VoiceSample['source'] = 'reddit_post'): VoiceSample[] {
  return texts.map((text, i) => ({
    id: `s${i}`,
    source,
    text,
    score: 10 + i,
  }));
}

function vec(overrides: Partial<StyleVector> = {}): StyleVector {
  return { ...extractStyle('baseline text for the vector. it has two sentences here.').vector, ...overrides };
}

describe('extractStyle', () => {
  it('produces every StyleVector dimension', () => {
    const { vector } = extractStyle('Hello world. This is a second sentence!');
    const expected: (keyof StyleVector)[] = [
      'avgWordLength', 'avgSentenceWords', 'sentenceLengthVariance', 'wordsPerPost',
      'typeTokenRatio', 'rareWordRate', 'commaPerSentence', 'questionRate', 'exclamationRate',
      'ellipsisRate', 'emDashRate', 'semicolonRate', 'parenthesesRate', 'formality', 'humor',
      'emojiRate', 'profanityRate', 'contractionRate', 'lowercaseRatio', 'capsWordRatio',
      'firstPersonRate', 'secondPersonRate', 'bulletRatio', 'codeBlockRate', 'linkRate',
      'headerRate', 'paragraphWords', 'hedgeRate', 'certaintyRate',
    ];
    for (const key of expected) {
      expect(typeof vector[key], `${key} should be a number`).toBe('number');
      expect(Number.isFinite(vector[key]), `${key} should be finite`).toBe(true);
    }
  });

  it('scores casual writing below formal writing on formality', () => {
    const casual = extractStyle("i don't know, it just works for me lol. it's fine, whatever").vector;
    const formal = extractStyle(
      'It is worth noting that the implementation substantially improved reliability. Furthermore, the team recommends a phased rollout.',
    ).vector;
    expect(casual.formality).toBeLessThan(formal.formality);
    expect(formal.formality).toBeGreaterThan(0.55);
  });

  it('detects emoji, ellipsis and question rates', () => {
    const { vector } = extractStyle('why did this break? \u{1F914} it said ok... then nothing \u{1F680}');
    expect(vector.emojiRate).toBeGreaterThan(0);
    expect(vector.ellipsisRate).toBeGreaterThan(0);
    expect(vector.questionRate).toBeGreaterThan(0);
  });

  it('ignores code blocks when measuring punctuation habits', () => {
    const withCode = extractStyle('intro. ```\nconst a = 1; // wow!!!\n``` outro.').vector;
    const withoutCode = extractStyle('intro. outro.').vector;
    expect(withCode.exclamationRate).toBeLessThanOrEqual(withoutCode.exclamationRate + 1);
  });

  it('is stable across repeated calls', () => {
    const a = extractStyle(CASUAL_SAMPLES.join('\n\n')).vector;
    const b = extractStyle(CASUAL_SAMPLES.join('\n\n')).vector;
    expect(a).toEqual(b);
  });

  it('handles empty input without NaN', () => {
    const { vector } = extractStyle('');
    for (const value of Object.values(vector)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('aggregateStyle', () => {
  it('weights high-scoring samples higher', () => {
    const low = samples(['ok so i guess it works honestly. maybe. not sure.']);
    const high = samples(['the rewrite fixed it. i shipped it and it works. clean, fast, done.']);
    const { vector } = aggregateStyle([...low, ...high]);
    expect(vector.wordsPerPost).toBeGreaterThan(0);
    expect(vector.avgSentenceWords).toBeGreaterThan(0);
  });

  it('reports variance so the scorer can tolerate natural inconsistency', () => {
    const { variance } = aggregateStyle(samples(CASUAL_SAMPLES));
    expect(Object.keys(variance).length).toBeGreaterThan(10);
    expect(variance.avgSentenceWords).toBeGreaterThan(0);
  });

  it('returns a zeroed vector for an empty corpus', () => {
    const { vector, variance } = aggregateStyle([]);
    expect(vector.wordsPerPost).toBe(0);
    expect(variance).toEqual({});
  });
});

describe('countAiTells', () => {
  it('flags agency copy', () => {
    const tells = countAiTells(
      "In today's fast-paced landscape, it's important to note that we strive to unlock the power of seamless solutions. I hope this helps!",
    );
    expect(tells.length).toBeGreaterThan(2);
  });

  it('leaves human writing alone', () => {
    expect(countAiTells('the retry logic was wrong because i cached the failure too')).toEqual([]);
  });

  it('does not fire on a single legitimate word usage', () => {
    // "landscape" alone should not condemn an otherwise human post.
    const tells = countAiTells('our landscape photography app is still not done, sorry');
    expect(tells).not.toContain('landscape');
  });
});

describe('aggregateStyle with mixed sources', () => {
  it('averages across post types without exploding on short comments', () => {
    const mixed: VoiceSample[] = [
      { id: '1', source: 'reddit_post', text: CASUAL_SAMPLES[0]!, score: 100 },
      { id: '2', source: 'reddit_comment', text: 'lol same', score: 3 },
      { id: '3', source: 'commit', text: 'fix: handle empty release notes', score: 0 },
      { id: '4', source: 'readme', text: '# Tool\n\nA tiny CLI that does one thing.', score: 0 },
    ];
    const { vector } = aggregateStyle(mixed);
    expect(vector.wordsPerPost).toBeGreaterThan(0);
    expect(vector.formality).toBeGreaterThanOrEqual(0);
    expect(vector.formality).toBeLessThanOrEqual(1);
  });

  it('vec helper produces an overridable baseline', () => {
    expect(vec({ humor: 0.9 }).humor).toBe(0.9);
  });
});
