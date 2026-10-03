/**
 * Authenticity scorer.
 *
 * Produces a 0-100 "does this sound like *them*" score from six weighted signals.
 * Anything under the threshold is regenerated rather than posted — generic AI
 * copy gets downvoted, and downvoting a founder's account is expensive.
 */
import { countAiTells, extractStyle } from './style.js';
import type { StyleVector, VoiceProfile } from './types.js';
import { clamp, cosine, countMatches, hashedEmbedding, mean, rate, round, splitSentences, STOP_WORDS, tokenize } from './utils.js';

export interface AuthenticityReport {
  score: number;
  passed: boolean;
  /** Per-signal breakdown, 0-100 each. Surfaced live in the dashboard editor. */
  breakdown: {
    styleMatch: number;
    vocabulary: number;
    rhythm: number;
    punctuation: number;
    ngramSimilarity: number;
    platformNative: number;
    penalty: number;
  };
  notes: string[];
  /** Suggestions the generator can act on when regenerating. */
  directives: string[];
}

export interface ScoreOptions {
  threshold?: number;
  /** Reddit-native requirements (paragraph length, no link in first paragraph, etc.). */
  platformNative?: boolean;
}

const WEIGHTS = {
  styleMatch: 0.24,
  vocabulary: 0.18,
  rhythm: 0.16,
  punctuation: 0.12,
  ngramSimilarity: 0.16,
  platformNative: 0.14,
} as const;

/** Distance in "tolerance units" at which a dimension stops contributing meaningfully. */
function dimensionScore(delta: number, tolerance: number): number {
  if (tolerance <= 0) return delta === 0 ? 100 : 0;
  return round(clamp(1 - delta / tolerance) * 100);
}

/**
 * Per-dimension tolerances. They encode what actually matters on Reddit:
 * nobody cares if you use semicolons, everybody notices if your posts read like
 * a press release or arrive in 900-word paragraphs.
 */
const TOLERANCE: Record<keyof StyleVector, number> = {
  avgWordLength: 1.4,
  avgSentenceWords: 7,
  sentenceLengthVariance: 4,
  wordsPerPost: 1.1, // compared in log space
  typeTokenRatio: 0.22,
  rareWordRate: 0.12,
  commaPerSentence: 1.1,
  questionRate: 0.35,
  exclamationRate: 0.35,
  ellipsisRate: 2.5,
  emDashRate: 2.5,
  semicolonRate: 1.5,
  parenthesesRate: 2.5,
  formality: 0.22,
  humor: 0.28,
  emojiRate: 1.6,
  profanityRate: 1.2,
  contractionRate: 3,
  lowercaseRatio: 0.25,
  capsWordRatio: 0.08,
  firstPersonRate: 3,
  secondPersonRate: 4,
  bulletRatio: 0.4,
  codeBlockRate: 4,
  linkRate: 3,
  headerRate: 2,
  paragraphWords: 26,
  hedgeRate: 1.6,
  certaintyRate: 1.6,
};

/** Dimensions where a big deviation is a much bigger deal than the rest. */
const CRITICAL: (keyof StyleVector)[] = ['formality', 'avgSentenceWords', 'paragraphWords', 'typeTokenRatio'];

/**
 * Score a candidate body against a trained voice profile.
 *
 * When the profile was trained on few samples the scorer widens its tolerances
 * rather than pretending to know more than it does.
 */
export function scoreAuthenticity(
  body: string,
  profile: VoiceProfile,
  options: ScoreOptions = {},
): AuthenticityReport {
  const threshold = options.threshold ?? 85;
  const notes: string[] = [];
  const directives: string[] = [];
  const target = profile.vector;
  const extraction = extractStyle(body);
  const actual = extraction.vector;

  // Small corpora => noisier style estimates => loosen the gates.
  const confidencePenalty = profile.sampleCount < 8 ? (8 - profile.sampleCount) * 0.9 : 0;
  const scale = (tolerance: number) => tolerance * (1 + confidencePenalty / 100);

  const dims = Object.keys(TOLERANCE) as (keyof StyleVector)[];
  const scores: number[] = [];
  const criticalScores: number[] = [];

  for (const dim of dims) {
    let targetValue = target[dim] ?? 0;
    let actualValue = actual[dim] ?? 0;
    if (dim === 'wordsPerPost') {
      targetValue = Math.log1p(targetValue);
      actualValue = Math.log1p(actualValue);
    }
    const delta = Math.abs(actualValue - targetValue);
    // A trained spread means the founder is naturally inconsistent here — forgive more.
    const learnedSpread = Math.sqrt(profile.variance[dim] ?? 0);
    const tolerance = scale(TOLERANCE[dim] + Math.min(learnedSpread, TOLERANCE[dim] * 0.9));
    const s = dimensionScore(delta, tolerance);
    scores.push(s);
    if (CRITICAL.includes(dim)) criticalScores.push(s);
    if (s < 55) {
      notes.push(`${dim}: draft ${fmt(actualValue)} vs profile ${fmt(targetValue)}`);
      directives.push(describeDirective(dim, actualValue, targetValue));
    }
  }

  const styleMatch = mean(scores);
  const criticalMatch = mean(criticalScores);

  /* ---------------- vocabulary ---------------- */
  const draftTokens = tokenize(body);
  const draftUniq = new Set(draftTokens);
  const favorites = profile.favoriteWords;
  let vocabulary = 100;
  if (favorites.length > 0) {
    const hitCount = favorites.filter((w) => draftUniq.has(w)).length;
    // Reward a few characteristic words; never require the whole list.
    vocabulary = clamp(hitCount / Math.max(Math.min(favorites.length, 8) * 0.35, 1)) * 100;
    if (hitCount === 0) {
      vocabulary *= 0.75;
      notes.push('No characteristic vocabulary from the voice profile appears in the draft.');
      directives.push('Sprinkle in 2-3 words the founder actually uses.');
    }
  }

  /* ---------------- rhythm / structure ---------------- */
  const paragraphs = body.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const sentences = splitSentences(body);
  const longParagraphs = paragraphs.filter((p) => tokenize(p).length > 110).length;
  const longSentences = sentences.filter((s) => tokenize(s).length > 34).length;
  let rhythm = 100;
  rhythm -= clamp(longParagraphs / Math.max(paragraphs.length, 1)) * 60;
  rhythm -= clamp(longSentences / Math.max(sentences.length, 1)) * 45;
  if (rhythm < 70) {
    directives.push('Shorten paragraphs and sentences — Reddit reads on a phone.');
  }

  /* ---------------- punctuation habits ---------------- */
  let punctuation = 100;
  const profileHasEllipsis = (target.ellipsisRate ?? 0) > 1.2;
  const profileNoEllipsis = (target.ellipsisRate ?? 0) < 0.4;
  if (profileNoEllipsis && (actual.ellipsisRate ?? 0) > 1.5) {
    punctuation -= 12;
    directives.push('Drop the ellipses — this voice does not use them.');
  }
  if (profileHasEllipsis && (actual.ellipsisRate ?? 0) < 0.2) {
    punctuation -= 6;
  }
  const bangs = countMatches(body, /!/g);
  if (bangs > Math.max(2, extraction.charCount / 300)) {
    punctuation -= clamp((bangs - 2) * 4);
    directives.push('Too many exclamation marks.');
  }
  if (countMatches(body, /—/g) > Math.max(3, extraction.charCount / 200)) {
    punctuation -= 8;
    directives.push('Fewer em dashes.');
  }

  /* ---------------- n-gram similarity to real writing ---------------- */
  const draftEmbedding = hashedEmbedding(body, profile.embedding.length || 192);
  const rawSim = cosine(draftEmbedding, profile.embedding);
  // Cosine on sparse hashed vectors is small by construction; rescale into a usable band.
  const ngramSimilarity = clamp((rawSim - 0.04) / 0.3) * 100;
  if (ngramSimilarity < 45) {
    directives.push('Too far from how this founder actually writes — use their phrasing patterns.');
  }

  /* ---------------- platform-native quality ---------------- */
  let platformNative = 100;
  if (options.platformNative !== false) {
    const checks: Array<[boolean, string, number]> = [
      [paragraphs.length >= 2, 'Break the post into multiple short paragraphs.', 18],
      [
        extraction.charCount < 12000,
        'Reddit posts over ~10k characters get truncated in the feed. Cut it down.',
        14,
      ],
      [!/https?:\/\//.test(paragraphs[0] ?? ''), 'No links in the first paragraph.', 22],
      [!/^\s*(?:edit|update|op|p\.?s\.?h?\.?u?\.?)\s*:/im.test(body), 'Drop the "Edit:" preamble.', 8],
      [
        !/^#{1,3}\s/im.test(body) && (actual.headerRate ?? 0) < 1.5,
        'Avoid heading syntax in the body; Reddit-native means plain paragraphs.',
        10,
      ],
      [
        !body.trimEnd().endsWith('...'),
        'Do not end on a cliffhanger — close with a question or a takeaway.',
        8,
      ],
    ];
    for (const [ok, note, cost] of checks) {
      if (!ok) {
        platformNative -= cost;
        directives.push(note);
      }
    }
  }

  /* ---------------- hard penalties ---------------- */
  let penalty = 0;
  const aiTells = countAiTells(body);
  if (aiTells.length > 0) {
    penalty += clamp(aiTells.length * 9, 0, 32);
    notes.push(`Reads like AI copy: "${aiTells.slice(0, 3).join('", "')}"`);
    directives.push(`Remove AI-tell phrasing (${aiTells.slice(0, 3).join(', ')}).`);
  }
  const banned = profile.bannedWords.filter((w) => new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(body));
  if (banned.length > 0) {
    penalty += clamp(banned.length * 8, 0, 24);
    notes.push(`Uses words this founder never uses: ${banned.slice(0, 4).join(', ')}`);
    directives.push(`Avoid: ${banned.slice(0, 4).join(', ')}`);
  }
  const bannedPhrases = profile.settings.bannedPhrases.filter((p) =>
    body.toLowerCase().includes(p.toLowerCase()),
  );
  if (bannedPhrases.length > 0) {
    penalty += clamp(bannedPhrases.length * 10, 0, 20);
    notes.push(`Blocked phrases: ${bannedPhrases.join(', ')}`);
  }
  const emojiBurst = actual.emojiRate ?? 0;
  const allowedEmoji = Math.max(profile.settings.emojiRate, (target.emojiRate ?? 0) * 1.8, 0.6);
  if (emojiBurst > allowedEmoji * 2.5) {
    penalty += clamp((emojiBurst - allowedEmoji) * 2, 0, 12);
    directives.push('Too many emojis for this voice.');
  }
  if (!profile.settings.profanityAllowed && (actual.profanityRate ?? 0) > 0.5) {
    penalty += 6;
  }

  /* ---------------- weighted total ---------------- */
  const positive =
    styleMatch * WEIGHTS.styleMatch +
    vocabulary * WEIGHTS.vocabulary +
    rhythm * WEIGHTS.rhythm +
    punctuation * WEIGHTS.punctuation +
    ngramSimilarity * WEIGHTS.ngramSimilarity +
    platformNative * WEIGHTS.platformNative;

  // criticalMatch acts as a multiplier: one badly wrong critical dimension sinks the draft.
  const criticalFactor = clamp(criticalMatch / 100, 0.35, 1);
  const raw = positive * criticalFactor - penalty;
  const score = round(clamp(raw / 100) * 100, 1);

  return {
    score,
    passed: score >= threshold,
    breakdown: {
      styleMatch: round(styleMatch),
      vocabulary: round(vocabulary),
      rhythm: round(rhythm),
      punctuation: round(punctuation),
      ngramSimilarity: round(ngramSimilarity),
      platformNative: round(platformNative),
      penalty: round(penalty),
    },
    notes,
    directives: [...new Set(directives)],
  };
}

/** Convenience wrapper: score a full draft (title + body + first comment). */
export function scoreDraftAuthenticity(
  draft: { title: string; body: string },
  profile: VoiceProfile,
  options: ScoreOptions = {},
): AuthenticityReport {
  // Titles are short and stylistically different; score them with a lower weight.
  const body = scoreAuthenticity(draft.body, profile, options);
  if (!draft.title.trim()) return body;
  const title = scoreAuthenticity(draft.title, profile, { ...options, platformNative: false });
  const score = round(body.score * 0.78 + title.score * 0.22, 1);
  return {
    ...body,
    score,
    passed: score >= (options.threshold ?? 85),
    notes: [...body.notes, ...title.notes.slice(0, 3)],
    directives: [...new Set([...body.directives, ...title.directives])],
  };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function describeDirective(dim: keyof StyleVector, actual: number, target: number): string {
  const direction = actual > target ? 'more' : 'less';
  switch (dim) {
    case 'formality':
      return `Sound ${direction} casual — match the founder's register.`;
    case 'avgSentenceWords':
      return `Keep sentences ${direction} punchy (profile averages ${fmt(target)} words).`;
    case 'paragraphWords':
      return `Paragraphs should average ~${fmt(target)} words, not ${fmt(actual)}.`;
    case 'typeTokenRatio':
      return `Vocabulary variety is ${direction} than the profile — vary word choice.`;
    case 'emojiRate':
      return `Use ${direction} emojis than the profile does.`;
    case 'questionRate':
      return `Ask ${direction} questions.`;
    case 'humor':
      return `Lean ${direction} playful / ${direction === 'more' ? 'deadpan' : 'playful'} in tone.`;
    case 'firstPersonRate':
      return `Write ${direction} in the first person — this voice does.`;
    case 'codeBlockRate':
      return `Include ${direction} code than the profile does.`;
    case 'linkRate':
      return `Include ${direction} links than the profile does.`;
    case 'avgWordLength':
      return `Use ${direction} complex words than the founder does.`;
    case 'contractionRate':
      return `Use ${direction === 'more' ? 'more' : 'fewer'} contractions.`;
    case 'hedgeRate':
      return `Sound ${direction} hedged than the founder sounds.`;
    default:
      return `Adjust ${dim}: draft ${fmt(actual)}, profile ${fmt(target)}.`;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Per-title-variant scoring so the dashboard can A/B test titles honestly:
 * only the title changes, the body stays constant.
 */
export function rankTitleVariants(
  variants: readonly string[],
  body: string,
  profile: VoiceProfile,
): Array<{ title: string; score: number }> {
  const bodyTokens = new Set(tokenize(body));
  return variants
    .map((title) => {
      const voice = scoreAuthenticity(title, profile, { platformNative: false }).score;
      // A title that promises something the body never mentions reads as bait,
      // so reward title/body vocabulary agreement a little.
      const titleWords = tokenize(title).filter((w) => !STOP_WORDS.has(w));
      const overlap =
        titleWords.length === 0
          ? 0
          : titleWords.filter((w) => bodyTokens.has(w)).length / titleWords.length;
      return { title, score: round(voice * 0.82 + overlap * 100 * 0.18, 1) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Rough "will this get clicked" heuristic layered on top of voice match. */
export function clickAppeal(title: string): number {
  const len = title.length;
  let score = 50;
  score += len >= 30 && len <= 85 ? 18 : -8;
  if (/\d/.test(title)) score += 8;
  if (/^(how|why|what|when|i |we )/i.test(title)) score += 8;
  if (/^\s*(help|psst|question|anyone)\b/i.test(title)) score -= 12;
  if (title.includes(':') && title.split(':').length === 2) score += 4;
  if (/[!?]{2,}/.test(title)) score -= 6;
  if (len > 110) score -= 15;
  return round(clamp(score / 100) * 100);
}

/** Emoji density helper used by the generator's style-targeting pass. */
export function emojiRate(text: string): number {
  return round(rate((text.match(/\p{Extended_Pictographic}/gu) ?? []).length, text.length), 2);
}