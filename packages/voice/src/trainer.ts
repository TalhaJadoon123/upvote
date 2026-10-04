/**
 * Voice profile trainer.
 *
 * Input: everything the founder has ever written publicly (Reddit posts and
 * comments, tweets, blog posts, READMEs, commit messages).
 * Output: a compact VoiceProfile that the generator and authenticity scorer use.
 *
 * Design notes:
 *  - Samples are weighted by engagement, so the founder's *successful* writing
 *    dominates the profile.
 *  - Rare content words are promoted (TF-IDF style) so the profile captures
 *    vocabulary, not function words.
 *  - Banned words are derived, not guessed: any AI/agency tell the founder
 *    demonstrably does not use becomes a ban.
 */
import {
  AI_TELLS,
  aggregateStyle,
  extractStyle,
  hashedEmbedding,
  slugify,
  STOP_WORDS,
  VoiceProfileSchema,
  tokenize,
  unique,
  type StyleVector,
  type VoiceProfile,
  type VoiceSample,
} from '@upvote/core';

export interface TrainOptions {
  userId: string;
  /** Stable id so retraining can version a profile. */
  profileId?: string;
  version?: number;
  /** Words/phrases the founder explicitly never wants to see. */
  bannedPhrases?: string[];
  bannedWords?: string[];
  profanityAllowed?: boolean;
  ctaStyle?: 'none' | 'soft' | 'direct';
  /** Override the measured formality, 0-1. */
  formalityOverride?: number;
  humorOverride?: number;
}

export interface TrainResult {
  profile: VoiceProfile;
  quality: ProfileQuality;
}

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

interface WordStat {
  word: string;
  weightedCount: number;
  docCount: number;
}

/**
 * TF-IDF-ish keyword extraction. Without a reference corpus we approximate IDF
 * by document frequency: a word used in *every* sample carries less identity
 * than one used in the founder's characteristic way.
 */
export function extractVocabulary(
  samples: readonly VoiceSample[],
  limit = 40,
): { favorite: string[]; signature: string[]; ranked: WordStat[] } {
  const stats = new Map<string, WordStat>();
  const docCount = Math.max(samples.length, 1);

  for (const sample of samples) {
    const weight = Math.max(1, Math.log2(1 + Math.max(sample.score ?? 0, 0)));
    const seen = new Set<string>();
    for (const token of tokenize(sample.text)) {
      if (token.length < 3) continue;
      if (STOP_WORDS.has(token)) continue;
      if (/^\d+$/.test(token)) continue;
      const stat = stats.get(token) ?? { word: token, weightedCount: 0, docCount: 0 };
      stat.weightedCount += weight;
      if (!seen.has(token)) {
        seen.add(token);
        stat.docCount += 1;
      }
      stats.set(token, stat);
    }
  }

  const ranked = [...stats.values()]
    .map((s) => ({ ...s, score: s.weightedCount * (1 + Math.log(docCount / s.docCount)) }))
    .sort((a, b) => b.score - a.score);

  const favorite = unique(
    ranked
      .filter((s) => s.word.length > 3)
      .slice(0, limit)
      .map((s) => s.word),
  );

  const signature = extractSignaturePhrases(samples, 12);
  return { favorite, signature, ranked: ranked.slice(0, 60) };
}

/**
 * Find n-grams (2-5 words) that recur across samples. These are the highest
 * value signal in the whole system: they are literally how this person phrases
 * things, and they feed both the prompt and the lexical scorer.
 */
export function extractSignaturePhrases(
  samples: readonly VoiceSample[],
  limit = 12,
  minWords = 2,
  maxWords = 5,
): string[] {
  const counts = new Map<string, { count: number; weight: number }>();

  for (const sample of samples) {
    const weight = Math.max(1, Math.log2(1 + Math.max(sample.score ?? 0, 0)));
    const tokens = tokenize(sample.text);
    for (let size = minWords; size <= maxWords; size++) {
      for (let i = 0; i + size <= tokens.length; i++) {
        const gram = tokens.slice(i, i + size);
        // A phrase must not start or end on a function word.
        if (STOP_WORDS.has(gram[0] ?? '') || STOP_WORDS.has(gram[gram.length - 1] ?? '')) continue;
        if (gram.some((t) => t.length < 2)) continue;
        const key = gram.join(' ');
        const entry = counts.get(key) ?? { count: 0, weight: 0 };
        entry.count += 1;
        entry.weight += weight * size;
        counts.set(key, entry);
      }
    }
  }

  // Prefer phrases that recur across different samples over repeats inside one.
  return [...counts.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].weight * Math.log(1 + b[1].count) - a[1].weight * Math.log(1 + a[1].count))
    .slice(0, limit)
    .map(([phrase]) => phrase);
}

/** Derive banned words: agency/AI tells the founder never uses. */
export function deriveBannedWords(samples: readonly VoiceSample[]): string[] {
  const corpus = samples.map((s) => ` ${tokenize(s.text).join(' ')} `).join(' ');
  return AI_TELLS.filter((tell) => {
    const phrase = tokenize(tell).join(' ');
    return phrase.length > 0 && !corpus.includes(phrase);
  });
}

export function extractEmojiFavorites(samples: readonly VoiceSample[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    for (const emoji of extractStyle(sample.text).emojis) {
      counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([emoji]) => emoji);
}

export function extractOpenersAndClosers(samples: readonly VoiceSample[]): {
  openers: string[];
  closers: string[];
} {
  const posts = samples.filter((s) => s.source === 'reddit_post' || s.source === 'blog' || s.source === 'tweet');
  const openers: string[] = [];
  const closers: string[] = [];
  for (const sample of posts) {
    const tokens = tokenize(sample.text);
    if (tokens.length >= 4) openers.push(tokens.slice(0, 4).join(' '));
    const lines = sample.text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) closers.push(last.split(/[.!?]/)[0]?.trim().slice(0, 90) ?? '');
  }
  return { openers: unique(openers).slice(0, 10), closers: unique(closers).filter(Boolean).slice(0, 10) };
}

/* ------------------------------------------------------------------ */
/* Quality                                                              */
/* ------------------------------------------------------------------ */

export interface ProfileQuality {
  /** 0-100. Below ~40 the generator is noticeably weaker and says so in the UI. */
  score: number;
  sampleCount: number;
  bySource: Record<string, number>;
  /** Corpus length in words. */
  words: number;
  /** How much the founder's writing varies; very low means a thin sample. */
  variety: number;
  warnings: string[];
  readyForProduction: boolean;
}

export function assessQuality(
  samples: readonly VoiceSample[],
  vector: StyleVector,
): ProfileQuality {
  const bySource: Record<string, number> = {};
  let words = 0;
  for (const sample of samples) {
    bySource[sample.source] = (bySource[sample.source] ?? 0) + 1;
    words += tokenize(sample.text).length;
  }

  const warnings: string[] = [];
  let score = 0;
  score += Math.min(40, samples.length * 2.2);
  score += Math.min(25, Math.log10(Math.max(words, 1)) * 6);
  score += Math.min(20, Object.keys(bySource).length * 5);
  score += Math.min(15, vector.typeTokenRatio * 60);

  if (samples.length < 10) warnings.push('Fewer than 10 samples - the voice match will be loose.');
  if (words < 400) warnings.push('Under 400 words of training text. Add more comments.');
  if (!bySource.reddit_post) warnings.push('No Reddit posts in the sample. Add one or two.');
  if (!bySource.reddit_comment) warnings.push('No Reddit comments in the sample. This is where voice really shows.');
  if (!Object.keys(bySource).some((k) => k !== 'reddit_post' && k !== 'reddit_comment')) {
    warnings.push('Sample comes from a single source. Cross-post voice drifts.');
  }

  return {
    score: Math.round(score),
    sampleCount: samples.length,
    bySource,
    words,
    variety: vector.typeTokenRatio,
    warnings,
    readyForProduction: samples.length >= 15 && words >= 800,
  };
}

/* ------------------------------------------------------------------ */
/* Trainer                                                              */
/* ------------------------------------------------------------------ */

/**
 * Train a voice profile from raw writing samples.
 * Retraining is always a full rebuild: a profile is a derived artifact, and
 * merging old profiles drifts the voice toward its own output.
 */
export function trainVoiceProfile(
  samples: readonly VoiceSample[],
  options: TrainOptions,
): TrainResult {
  const usable = samples.filter((s) => s.text && s.text.trim().length >= 20);

  if (usable.length === 0) {
    throw new Error(
      'Cannot train a voice profile: no usable samples (need at least 20 characters each). Connect Reddit or GitHub first.',
    );
  }

  const { vector, variance } = aggregateStyle(usable);
  const { favorite, signature } = extractVocabulary(usable);
  const banned = unique([
    ...(options.bannedWords ?? []),
    ...deriveBannedWords(usable),
  ]);
  const { openers, closers } = extractOpenersAndClosers(usable);

  const profile = VoiceProfileSchema.parse({
    id: options.profileId ?? `vp_${slugify(options.userId, 24)}`,
    userId: options.userId,
    version: options.version ?? 1,
    sampleCount: usable.length,
    vector,
    variance,
    signaturePhrases: signature,
    favoriteWords: favorite,
    bannedWords: banned,
    emojiFavorites: extractEmojiFavorites(usable),
    openers,
    closers,
    embedding: hashedEmbedding(usable.map((s) => s.text).join('\n\n')),
    settings: {
      // Trust the measurement; the override is an escape hatch, not the default.
      formality: options.formalityOverride ?? vector.formality,
      humor: options.humorOverride ?? vector.humor,
      emojiRate: vector.emojiRate,
      profanityAllowed: options.profanityAllowed ?? vector.profanityRate > 0.4,
      ctaStyle: options.ctaStyle ?? 'soft',
      bannedPhrases: options.bannedPhrases ?? [],
    },
  });

  return { profile, quality: assessQuality(usable, vector) };
}

/**
 * Rebuild a profile with a manual knob adjustment, keeping the learned parts
 * intact. Used by the voice page sliders in the dashboard.
 */
export function adjustProfile(
  profile: VoiceProfile,
  patch: {
    formality?: number;
    humor?: number;
    emojiRate?: number;
    ctaStyle?: 'none' | 'soft' | 'direct';
    profanityAllowed?: boolean;
    bannedPhrases?: string[];
    bannedWords?: string[];
  },
): VoiceProfile {
  return VoiceProfileSchema.parse({
    ...profile,
    settings: {
      ...profile.settings,
      ...(patch.formality !== undefined ? { formality: clamp01(patch.formality) } : {}),
      ...(patch.humor !== undefined ? { humor: clamp01(patch.humor) } : {}),
      ...(patch.emojiRate !== undefined ? { emojiRate: Math.max(0, patch.emojiRate) } : {}),
      ...(patch.ctaStyle !== undefined ? { ctaStyle: patch.ctaStyle } : {}),
      ...(patch.profanityAllowed !== undefined ? { profanityAllowed: patch.profanityAllowed } : {}),
      ...(patch.bannedPhrases !== undefined ? { bannedPhrases: patch.bannedPhrases } : {}),
    },
    bannedWords: patch.bannedWords ? unique([...profile.bannedWords, ...patch.bannedWords]) : profile.bannedWords,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * A neutral profile for the zero-sample case.
 *
 * Used only by the onboarding preview, where refusing to show anything would
 * mean a new user sees an error instead of the product. It is deliberately
 * unopinionated (mid-formality, no emoji, plain prose) and is flagged by
 * `sampleCount: 0` so the UI can say the voice is not trained yet.
 */
export function bootstrapProfile(userId: string): VoiceProfile {
  const { vector, variance } = aggregateStyle([
    { text: 'here is what happened and what i changed to fix it.', score: 1 },
  ]);
  return VoiceProfileSchema.parse({
    id: `vp_bootstrap_${slugify(userId, 16)}`,
    userId,
    version: 0,
    sampleCount: 0,
    vector,
    variance,
    signaturePhrases: [],
    favoriteWords: [],
    bannedWords: [],
    emojiFavorites: [],
    openers: [],
    closers: [],
    embedding: [],
    settings: {
      formality: 0.5,
      humor: 0.25,
      emojiRate: 0.5,
      profanityAllowed: false,
      ctaStyle: 'soft',
      bannedPhrases: [],
    },
  });
}

/**
 * Merge a team member's profile into a shared "team voice" profile.
 * Numeric dimensions are averaged; lexical sets are unioned by frequency.
 */
export function mergeTeamProfiles(
  profiles: readonly VoiceProfile[],
  options: { userId: string; id?: string },
): VoiceProfile {
  if (profiles.length === 0) throw new Error('mergeTeamProfiles requires at least one profile');
  const vectorKeys = Object.keys(profiles[0]!.vector) as (keyof StyleVector)[];
  const vector = {} as StyleVector;
  for (const key of vectorKeys) {
    vector[key] =
      Math.round((profiles.reduce((acc, p) => acc + (p.vector[key] ?? 0), 0) / profiles.length) * 100) / 100;
  }

  const merged = VoiceProfileSchema.parse({
    id: options.id ?? `vp_team_${slugify(options.userId, 20)}`,
    userId: options.userId,
    version: 1,
    sampleCount: profiles.reduce((acc, p) => acc + p.sampleCount, 0),
    vector,
    variance: {},
    signaturePhrases: unique(profiles.flatMap((p) => p.signaturePhrases)).slice(0, 16),
    favoriteWords: unique(profiles.flatMap((p) => p.favoriteWords)).slice(0, 40),
    // A word banned by any member stays banned for the team.
    bannedWords: unique(profiles.flatMap((p) => p.bannedWords)),
    emojiFavorites: unique(profiles.flatMap((p) => p.emojiFavorites)).slice(0, 8),
    openers: unique(profiles.flatMap((p) => p.openers)).slice(0, 10),
    closers: unique(profiles.flatMap((p) => p.closers)).slice(0, 10),
    embedding: hashedEmbedding(profiles.map((p) => p.embedding.join(' ')).join('\n')),
    settings: {
      formality: profiles.reduce((a, p) => a + p.settings.formality, 0) / profiles.length,
      humor: profiles.reduce((a, p) => a + p.settings.humor, 0) / profiles.length,
      emojiRate: profiles.reduce((a, p) => a + p.settings.emojiRate, 0) / profiles.length,
      profanityAllowed: profiles.some((p) => p.settings.profanityAllowed),
      ctaStyle: profiles[0]!.settings.ctaStyle,
      bannedPhrases: unique(profiles.flatMap((p) => p.settings.bannedPhrases)),
    },
  });
  return merged;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Human-readable summary for the CLI and dashboard header. */
export function describeProfile(profile: VoiceProfile): string {
  const v = profile.vector;
  const register = v.formality > 0.6 ? 'professional' : v.formality > 0.4 ? 'plain' : 'casual';
  const pace = v.avgSentenceWords < 11 ? 'punchy' : v.avgSentenceWords < 18 ? 'steady' : 'long-form';
  const humor = v.humor > 0.45 ? 'playful' : v.humor > 0.2 ? 'occasional dry humor' : 'earnest';
  const emoji = v.emojiRate < 0.5 ? 'no emoji' : v.emojiRate < 2 ? 'light emoji use' : 'emoji-forward';
  const caps = v.lowercaseRatio > 0.6 ? 'lowercase' : 'sentence case';
  return `${register}, ${pace}, ${humor}, ${emoji}, ${caps}. ~${Math.round(v.avgSentenceWords)} words/sentence, ~${Math.round(v.paragraphWords)} words/paragraph, trained on ${profile.sampleCount} samples.`;
}