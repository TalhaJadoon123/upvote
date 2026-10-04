/**
 * Style vector extraction - the numeric fingerprint of how someone writes.
 *
 * Every dimension is normalized into a fixed range so the authenticity scorer can
 * compute a weighted distance between a candidate draft and a trained profile.
 * The lexicon lives here too, which lets us reuse it for banned-phrase detection.
 */
import type { StyleVector, VoiceSample } from './types.js';
import {
  clamp,
  countMatches,
  mean,
  rate,
  splitSentences,
  stripCodeBlocks,
  sum,
  tokenize,
} from './utils.js';

export const CONTRACTIONS = [
  "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't", "wasn't", "weren't", "i'm", "i've",
  "i'll", "i'd", "it's", "it's", "that's", "there's", "here's", "what's", "you're", "you've", "you'll",
  "we're", "we've", "we'll", "they're", "they've", "he'd", "she'd", "couldn't", "wouldn't", "shouldn't",
  "haven't", "hasn't", "hadn't", "ain't", "gonna", "wanna", "kinda", "sorta", "cuz", "u", "ur",
];

export const SLANG = [
  'lol', 'lmao', 'haha', 'tbh', 'imo', 'ngl', 'fwiw', 'yikes', 'nooo', 'yep', 'yup', 'nah', 'ok', 'okay',
  'stuff', 'thing', 'guy', 'guys', 'kids', 'ppl', 'rn', 'btw', 'af', 'obsessed', 'crazy', 'insane',
  'weird', 'nice', 'cool', 'huge', 'massive', 'tiny', 'huge win',
];

export const FORMAL_MARKERS = [
  'therefore', 'furthermore', 'additionally', 'consequently', 'hereby', 'aforementioned', 'utilize',
  'facilitate', 'endeavor', 'in order to', 'with regard to', 'in terms of', 'on the other hand',
  'it is worth noting', 'that being said', 'moving forward', 'at this point in time', 'stakeholders',
  'stakeholder', 'deliverables', 'synergy', 'leverage', 'robust', 'seamless', 'cutting-edge',
  'best-in-class', 'world-class', 'next-level', 'game-changer', 'revolutionize', 'unlock the power',
  'empower', 'holistic', 'ecosystem', 'journey', 'empowering', 'innovative', 'transformative',
];

export const HEDGE_MARKERS = [
  'i think', 'maybe', 'probably', 'i guess', 'sort of', 'kind of', 'i think so', 'not sure',
  "i don't know", 'idk', 'probably', 'possibly', 'seems like', 'might be', 'could be', 'somehow',
];

export const CERTAINTY_MARKERS = [
  'definitely', 'absolutely', 'always', 'never', 'clearly', 'obviously', 'undoubtedly', '100%',
  'without a doubt', 'i guarantee', 'hands down', 'no doubt',
];

export const HUMOR_MARKERS = [
  'lol', 'lmao', 'rofl', 'haha', '\u{1F602}', '\u{1F923}', '\u{1F480}', '\u{1F62C}', 'dead', 'kill me', 'i cannot', 'unbelievable',
  'ridiculous', 'insane', 'cursed', 'blessed', 'apparently', 'somehow', 'of course', 'surprise',
  'plot twist', 'who else', 'nobody:', 'me_irl', 'skill issue', 'touch grass', 'copium',
];

export const PROFANITY = [
  'fuck', 'shit', 'damn', 'hell', 'crap', 'ass', 'bastard', 'bullshit', 'goddamn', 'wtf', 'fml',
];

export const EMOJI_RE = /\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*/gu;
export const ELLIPSIS_RE = /\.{3}|\u2026/g;
export const EM_DASH_RE = /\s\u2014\s|\u2014/g;
export const BULLET_RE = /^\s*[-*\u2022]\s+/gm;
export const CODE_BLOCK_RE = /```[\s\S]*?```/g;
export const HEADER_RE = /^\s*#{1,6}\s+\S/gm;
export const URL_RE = /https?:\/\/[^\s)\]]+/g;

/** Words that instantly read as AI/agency copy. Never allowed above the hard threshold. */
export const AI_TELLS = [
  'delve', 'leverage', 'realm', 'tapestry', 'testament', 'showcase', 'underscores', 'pivotal',
  'multifaceted', 'myriad', 'plethora', 'crucial', 'seamlessly', 'meticulously', 'foster',
  'landscape', 'journey', 'navigate the', "in today's fast-paced", "let's dive in", 'dive in',
  "here's the thing", 'at the end of the day', "it's important to note", 'game changer',
  'unlock', 'supercharge', '10x', 'revolutionary', 'cutting edge', 'seamlessly integrate',
  'i hope this helps', 'let me know if', 'feel free to reach out', 'moreover', 'furthermore',
  'in conclusion', 'to sum up', 'needless to say', 'bear with me', 'buckle up', 'tl;dr',
];

export interface StyleExtraction {
  vector: StyleVector;
  wordCount: number;
  charCount: number;
  sentenceCount: number;
  paragraphCount: number;
  tokens: string[];
  emojis: string[];
}

function firstPersonRate(tokens: readonly string[], charCount: number): number {
  const hits = sum(
    tokens.map((t) => (['i', 'me', 'my', 'mine', 'myself', "i'm", "i've", "i'd", "i'll"].includes(t) ? 1 : 0)),
  );
  return rate(hits, charCount);
}

function secondPersonRate(tokens: readonly string[], charCount: number): number {
  const hits = sum(
    tokens.map((t) =>
      ['you', 'your', 'yours', "you're", "you've", "you'll", 'u', 'ur'].includes(t) ? 1 : 0,
    ),
  );
  return rate(hits, charCount);
}

function formalityScore(text: string, sentences: readonly string[]): number {
  const lower = text.toLowerCase();
  const chars = Math.max(text.length, 1);
  const words = tokenize(text).length;

  const contractionHits = CONTRACTIONS.reduce((acc, c) => acc + countMatches(lower, new RegExp(`\\b${c}\\b`, 'g')), 0);
  const contractionDensity = clamp(contractionHits / (chars / 500));

  const formalHits = FORMAL_MARKERS.reduce(
    (acc, m) => acc + countMatches(lower, new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')),
    0,
  );

  const slangHits = SLANG.reduce(
    (acc, s) => acc + countMatches(lower, new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')),
    0,
  );

  const profanityHits = PROFANITY.reduce((acc, p) => acc + countMatches(lower, new RegExp(`\\b${p}`, 'gi')), 0);

  const avgSent = mean(sentences.map((s) => tokenize(s).length));
  const honorifics = countMatches(lower, /\b(sir|madam|kindly|please find|hereby|respectfully)\b/gi);

  // Start from a neutral, everyday-voice midpoint and move from there.
  let score = 0.5;
  score -= clamp(contractionDensity / 12) * 0.3;
  score -= clamp(slangHits / 4) * 0.16;
  score -= clamp(profanityHits / 3) * 0.12;
  score += clamp(formalHits / 4) * 0.2;
  score += clamp(honorifics / 3) * 0.12;
  score += clamp((avgSent - 12) / 25) * 0.2;
  // Absent contractions is itself a mild formality signal.
  if (contractionHits === 0 && words > 20) score += 0.06;
  return clamp(score);
}

function humorScore(text: string): number {
  const lower = text.toLowerCase();
  const chars = Math.max(text.length, 1);
  let hits = 0;
  for (const marker of HUMOR_MARKERS) {
    hits += countMatches(lower, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  }
  const bangs = countMatches(text, /!/g);
  const emojis = countMatches(text, EMOJI_RE);
  return clamp(hits / 6 + bangs / (chars / 120) / 2 + emojis / (chars / 400) / 2);
}

/**
 * Extract a raw style vector from one or more bodies of text.
 * When given a corpus, this averages per-sample vectors so long and short samples
 * do not skew the result.
 */
export function extractStyle(text: string): StyleExtraction {
  const tokens = tokenize(text);
  const sentences = splitSentences(text);
  const charCount = text.length;
  const wordCount = tokens.length;
  const sentenceLengths = sentences.map((s) => tokenize(s).length).filter((n) => n > 0);
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const prose = stripCodeBlocks(text);

  const avgWordLength = wordCount === 0 ? 0 : mean(tokens.map((t) => t.length));
  const avgSentenceWords = sentenceLengths.length === 0 ? 0 : mean(sentenceLengths);
  const variance =
    sentenceLengths.length < 2 ? 0 : mean(sentenceLengths.map((n) => (n - avgSentenceWords) ** 2));

  const unique = new Set(tokens);
  const emojis = [...text.matchAll(EMOJI_RE)].map((m) => m[0]);

  const vector: StyleVector = {
    avgWordLength: round2(avgWordLength),
    avgSentenceWords: round2(avgSentenceWords),
    sentenceLengthVariance: round2(Math.sqrt(variance)),
    wordsPerPost: wordCount,
    typeTokenRatio: wordCount === 0 ? 0 : round2(clamp(unique.size / wordCount)),
    rareWordRate: wordCount === 0 ? 0 : round2(clamp([...unique].filter((t) => t.length >= 9).length / unique.size)),
    commaPerSentence: sentences.length === 0 ? 0 : round2(countMatches(prose, /,/g) / sentences.length),
    questionRate: sentences.length === 0 ? 0 : round2(clamp(sentences.filter((s) => s.includes('?')).length / sentences.length)),
    exclamationRate: sentences.length === 0 ? 0 : round2(clamp(countMatches(prose, /!/g) / sentences.length)),
    ellipsisRate: round2(countMatches(prose, ELLIPSIS_RE) / Math.max(charCount / 1000, 1)),
    emDashRate: round2(countMatches(prose, EM_DASH_RE) / Math.max(charCount / 1000, 1)),
    semicolonRate: round2(countMatches(prose, /;/g) / Math.max(charCount / 1000, 1)),
    parenthesesRate: round2(countMatches(prose, /\(/g) / Math.max(charCount / 1000, 1)),
    formality: round2(formalityScore(text, sentences)),
    humor: round2(humorScore(text)),
    emojiRate: round2(rate(emojis.length, charCount)),
    profanityRate: round2(rate(PROFANITY.reduce((a, p) => a + countMatches(lower(text), new RegExp(`\\b${p}`, 'gi')), 0), charCount)),
    contractionRate: round2(rate(CONTRACTIONS.reduce((a, c) => a + countMatches(lower(text), new RegExp(`\\b${c}\\b`, 'g')), 0), charCount)),
    lowercaseRatio: round2(clamp(1 - (unique.size === 0 ? 0 : [...unique].filter((t) => /[A-Z]/.test(t)).length / unique.size))),
    capsWordRatio: round2(clamp(countMatches(text, /\b[A-Z]{2,}\b/g) / Math.max(wordCount, 1))),
    firstPersonRate: round2(firstPersonRate(tokens, charCount)),
    secondPersonRate: round2(secondPersonRate(tokens, charCount)),
    bulletRatio: round2(clamp(countMatches(text, BULLET_RE) / Math.max(paragraphs.length, 1))),
    codeBlockRate: round2(rate(countMatches(text, CODE_BLOCK_RE), charCount)),
    linkRate: round2(rate(countMatches(text, URL_RE), charCount)),
    headerRate: round2(rate(countMatches(text, HEADER_RE), charCount)),
    paragraphWords: round2(paragraphs.length === 0 ? 0 : mean(paragraphs.map((p) => tokenize(p).length))),
    hedgeRate: round2(
      HEDGE_MARKERS.reduce((a, m) => a + countMatches(lower(text), new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')), 0) /
        Math.max(charCount / 1000, 1),
    ),
    certaintyRate: round2(
      CERTAINTY_MARKERS.reduce((a, m) => a + countMatches(lower(text), new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')), 0) /
        Math.max(charCount / 1000, 1),
    ),
  };

  return { vector, wordCount, charCount, sentenceCount: sentences.length, paragraphCount: paragraphs.length, tokens, emojis };
}

/** Average a corpus of samples into one style vector plus per-dimension variance. */
export function aggregateStyle(
  samples: readonly Pick<VoiceSample, 'text' | 'score'>[],
): { vector: StyleVector; variance: Record<string, number> } {
  const extractions = samples
    .filter((s) => s.text.trim().length > 0)
    .map((s) => extractStyle(s.text));
  if (extractions.length === 0) {
    return { vector: extractStyle('').vector, variance: {} };
  }

  // Weight by upvote count when we have it: the founder's *successful* writing is the best sample.
  const weights = samples.map((s) => Math.max(1, Math.log2(1 + Math.max(s.score ?? 0, 0))));
  const totalWeight = sum(weights) || 1;

  const keys = Object.keys(extractions[0]!.vector) as (keyof StyleVector)[];
  const vector = {} as StyleVector;
  const variance: Record<string, number> = {};

  for (const key of keys) {
    // Store raw measurements. The scorer decides how to compare them (it applies
    // its own log transform to unbounded dimensions); transforming here too
    // would double-count and make the profile unreadable.
    let acc = 0;
    for (let i = 0; i < extractions.length; i++) {
      acc += extractions[i]!.vector[key] * (weights[i] ?? 1);
    }
    const avg = acc / totalWeight;
    (vector as Record<string, number>)[key] = round2(avg);

    if (extractions.length > 1) {
      const dev = extractions.map((e) => e.vector[key] - avg);
      variance[key] = round2(mean(dev.map((d) => d * d)));
    }
  }

  return { vector, variance };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lower(s: string): string {
  return s.toLowerCase();
}

/** Count AI-tell phrases. Used as a hard penalty in the authenticity scorer. */
export function countAiTells(text: string): string[] {
  const lowerText = text.toLowerCase();
  const found: string[] = [];
  for (const tell of AI_TELLS) {
    const escaped = tell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped, 'i').exec(lowerText);
    if (!match) continue;
    // Ambiguous single words only count when marketing language sits nearby,
    // so a legitimate "landscape photography app" is not flagged.
    if (AMBIGUOUS_TELLS.has(tell)) {
      const window = lowerText.slice(Math.max(0, match.index - 90), match.index + tell.length + 90);
      if (!MARKETING_CUE.test(window)) continue;
    }
    found.push(tell);
  }
  return found;
}

/** Tells that are legitimate in ordinary writing and only read as AI next to marketing filler. */
const AMBIGUOUS_TELLS = new Set([
  'landscape', 'journey', 'foster', 'testament', 'realm', 'showcase', 'tapestry',
  'multifaceted', 'plethora', 'myriad', 'pivotal', 'crucial', 'ecosystem', 'unlock',
]);

/** Words that establish marketing/agency context around an ambiguous tell. */
const MARKETING_CUE =
  /\b(solution|platform|unlock|seamless|leverage|deliver|empower|reimagine|comprehensive|enterprise|stakeholder|transformative|cutting[- ]edge|world[- ]class|seamlessly|streamline|robust|harness|journey)\b/i;

