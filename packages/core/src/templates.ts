/**
 * Draft templates.
 *
 * Two layers:
 *  1. `DraftStyle` — the five output shapes Upvote always produces for a moment.
 *  2. `DistributionTemplate` — pre-built, occasion-shaped templates used for the
 *     onboarding "wow" moment and for explicit template selection.
 *
 * Every template is voice-adaptive: the renderer conditions its phrasing on the
 * founder's formality / humor / emoji targets and pulls in characteristic words.
 */
import type { DraftStyle, ShippingMoment, VoiceProfile } from './types.js';
import { seededRandom, pick, slugify, tokenize, STOP_WORDS } from './utils.js';

/* ------------------------------------------------------------------ */
/* Voice conditioning                                                   */
/* ------------------------------------------------------------------ */

export interface VoiceKnobs {
  formality: number;
  humor: number;
  emojiRate: number;
  ctaStyle: 'none' | 'soft' | 'direct';
}

export function voiceKnobs(profile: VoiceProfile): VoiceKnobs {
  return {
    formality: (profile.settings.formality + profile.vector.formality) / 2,
    humor: (profile.settings.humor + profile.vector.humor) / 2,
    emojiRate: profile.settings.emojiRate || profile.vector.emojiRate,
    ctaStyle: profile.settings.ctaStyle,
  };
}

const CASUAL_OPENERS = [
  'ok so',
  'honestly',
  'tldr:',
  'no idea why this took me so long, but',
  'small win today:',
  'finally shipped the thing.',
];

const FORMAL_OPENERS = [
  'After some iteration,',
  'This one took longer than expected:',
  'Sharing a result that surprised me:',
  'A short write-up on something I just finished:',
];

const CASUAL_CLOSERS = [
  'happy to go deeper on any part of this.',
  'curious if anyone else has hit this.',
  'would love to hear what I am missing.',
  'open to being told I am overthinking this.',
];

const FORMAL_CLOSERS = [
  'I would welcome feedback from anyone who has solved this differently.',
  'If you have run into this, I am interested in how you handled it.',
  'Details and lessons in the comments.',
];

const QUESTION_CLOSERS = [
  'how are you handling this?',
  'curious what the rest of you do here.',
  'is there a cleaner way I am missing?',
  'what would you do differently?',
];

/** Pick phrasing that matches the founder's register. */
function opener(knobs: VoiceKnobs, rand: () => number): string {
  return knobs.formality > 0.55 ? pick(FORMAL_OPENERS, rand) : pick(CASUAL_OPENERS, rand);
}

function closer(knobs: VoiceKnobs, rand: () => number, question = false): string {
  if (question) return pick(QUESTION_CLOSERS, rand);
  if (knobs.ctaStyle === 'none') return '';
  if (knobs.ctaStyle === 'direct') return 'the repo is linked below if you want to poke at it.';
  return knobs.formality > 0.55 ? pick(FORMAL_CLOSERS, rand) : pick(CASUAL_CLOSERS, rand);
}

/** Decorate with emoji only as densely as the founder actually does. */
function maybeEmoji(knobs: VoiceKnobs, rand: () => number, pool: string[] = ['🚀', '🛠️', '💡', '😅', '🔥', '📈']): string {
  if (knobs.emojiRate < 0.8) return '';
  if (rand() > Math.min(knobs.emojiRate / 4, 0.85)) return '';
  return ` ${pick(pool, rand)}`;
}

/**
 * Introduce the founder's characteristic vocabulary so the draft shares wording
 * with the corpus rather than merely the same register. Always fires when the
 * profile has a usable word and the draft is long enough to read naturally.
 */
function voiceFlavor(text: string, profile: VoiceProfile, rand: () => number): string {
  const candidates = profile.favoriteWords.filter((w) => w.length > 3 && !text.includes(w));
  const word = candidates.length > 0 ? pick(candidates, rand) : null;
  if (!word) return text;

  const frames = [
    `long story short, the ${word} part is where it fell apart`,
    `the ${word} side of this took way longer than i expected`,
    `if you only take one thing: the ${word} work is 80% of the time`,
    `what i keep calling ${word}`,
    `the whole thing comes down to ${word}, honestly`,
  ];
  return `${text}\n\n${pick(frames, rand)}.`;
}

/* ------------------------------------------------------------------ */
/* Distribution templates (Phase 7 content library)                     */
/* ------------------------------------------------------------------ */

export interface DistributionTemplate {
  id: string;
  name: string;
  occasion: string;
  /** Preferred subreddit categories. */
  categories: string[];
  titlePatterns: string[];
  /** Prompts the LLM path fills in. Used verbatim in the prompt as guidance. */
  guidance: string;
  firstCommentGuidance: string;
  minMomentTags: string[];
}

export const DISTRIBUTION_TEMPLATES: DistributionTemplate[] = [
  {
    id: 'built_in_days',
    name: 'I built X in Y days',
    occasion: 'Shipping a side project on a public deadline',
    categories: ['webdev', 'programming', 'sideproject', 'selfhosted', 'indiehackers'],
    titlePatterns: [
      'I built {what} in {n} days. Here is what actually happened.',
      '{n} days to build {what}. Some numbers and a few regrets.',
      'Built {what} over a long weekend. Postmortem below.',
    ],
    guidance:
      'Lead with the time claim, then give the honest build log: what you cut, what broke, what you would skip. Include one real number (LOC, hours, cost, users). Be specific about the hard part.',
    firstCommentGuidance:
      'Answer the question you expect: what stack, what would you do differently, is the repo public.',
    minMomentTags: [],
  },
  {
    id: 'show_subreddit',
    name: 'Show r/X: my side project',
    occasion: 'Launching something visual or demonstrable',
    categories: ['webdev', 'programming', 'sideproject', 'selfhosted', 'devops'],
    titlePatterns: [
      'Show r/{sub}: {what} — {oneLine}',
      'Made a thing: {what}. It does {oneLine}.',
      '{what} — built this instead of sleeping',
    ],
    guidance:
      'Show the artifact early. Describe what it does in one plain sentence, no marketing adjectives. Say what it is NOT yet. Link goes in the last paragraph, never the first.',
    firstCommentGuidance: 'List the stack, the biggest known limitation, and invite specific criticism.',
    minMomentTags: [],
  },
  {
    id: 'quit_job',
    name: 'I quit my job to build X',
    occasion: 'A career-leap announcement',
    categories: ['indiehackers', 'entrepreneur', 'startups', 'programming', 'SaaS'],
    titlePatterns: [
      'I quit my job to build {what}. Here is my runway math.',
      'Two weeks into quitting to build {what}. Honest numbers so far.',
      'Left the job. Building {what}. Ask me anything about the numbers.',
    ],
    guidance:
      'Be transparent about money: runway, revenue, what you gave up. Do not romanticize it. Include the specific thing that made you finally quit.',
    firstCommentGuidance: 'Give the full runway table and the 3 things you wish you had known.',
    minMomentTags: [],
  },
  {
    id: 'hit_mrr',
    name: 'We hit $1K MRR. Here is how.',
    occasion: 'A revenue milestone',
    categories: ['SaaS', 'indiehackers', 'startups', 'Entrepreneur', 'selfhosted'],
    titlePatterns: [
      'Hit $1K MRR after {n} months. Here is exactly where it came from.',
      '$1K MRR. It was almost entirely one channel.',
      'Crossed $1K MRR this week. Breakdown inside.',
    ],
    guidance:
      'Attribute revenue to channels with real percentages. Name the acquisition channel that worked and the ones that did not. Include a chart-style list of numbers, not adjectives.',
    firstCommentGuidance: 'Answer the obvious follow-ups: churn, ARPU, how long to first dollar, what you would do differently.',
    minMomentTags: [],
  },
  {
    id: 'mistakes',
    name: 'The 5 mistakes I made building X',
    occasion: 'Anything with enough hindsight to be honest',
    categories: ['webdev', 'programming', 'indiehackers', 'SaaS', 'selfhosted'],
    titlePatterns: [
      '{n} mistakes I made building {what}. The {ordinal} one cost me the most.',
      'What I got wrong building {what}',
      'Building {what} taught me {n} things I had backwards.',
    ],
    guidance:
      'Each mistake must be specific and slightly embarrassing. Name the decision, the cost, and what you would do instead. No growth-mindset framing.',
    firstCommentGuidance: 'Invite others to add the mistake you did not make.',
    minMomentTags: [],
  },
  {
    id: 'analyzed_n',
    name: 'I analyzed 100 X. Here is what I found.',
    occasion: 'Any analysis over a real dataset',
    categories: ['data', 'datascience', 'programming', 'SaaS', 'ExperiencedDevs'],
    titlePatterns: [
      'I analyzed {n} {subject}. {surprisingFinding}.',
      'Looked at {n} {subject} — the results surprised me.',
      '{n} {subject}, one pattern: {surprisingFinding}',
    ],
    guidance:
      'State the headline finding in the title. Give the method and the sample size honestly, including the limitations. Use real numbers per point.',
    firstCommentGuidance: 'Share the raw data link and invite people to check the methodology.',
    minMomentTags: [],
  },
];

export function templateById(id: string): DistributionTemplate | undefined {
  return DISTRIBUTION_TEMPLATES.find((t) => t.id === id);
}

/* ------------------------------------------------------------------ */
/* Draft styles — the five outputs                                     */
/* ------------------------------------------------------------------ */

export interface StyleBlueprint {
  style: DraftStyle;
  label: string;
  /** How the post reads, for the model prompt. */
  guidance: string;
  /** Fallback renderer notes. */
  shape: string;
  questionClosing: boolean;
}

export const STYLE_BLUEPRINTS: StyleBlueprint[] = [
  {
    style: 'show_and_tell',
    label: 'Show-and-tell',
    guidance:
      'Open by naming the thing and what it does in one plain sentence. Then the interesting constraint you solved, then one honest limitation. No hype words. No "revolutionary". The link goes in the final paragraph.',
    shape: 'What it is → why it exists → hard part → limitation → link',
    questionClosing: false,
  },
  {
    style: 'story',
    label: 'Story',
    guidance:
      'Narrate a mistake or a struggle. Start in the middle of the problem, not the setup. Include the specific moment it clicked. End with the takeaway, not a moral.',
    shape: 'The moment it broke → what I tried → what actually fixed it → takeaway',
    questionClosing: false,
  },
  {
    style: 'question',
    label: 'Question',
    guidance:
      'Describe the concrete problem and what you already tried. Ask one specific question. Show your attempt (code, config, or numbers). Do not ask "any advice".',
    shape: 'What I am building → what breaks → what I tried → one specific question',
    questionClosing: true,
  },
  {
    style: 'data',
    label: 'Data',
    guidance:
      'Give the sample size and method, then the finding. Put the surprising number first. Be explicit about limitations of the data. No bullet-point fluff.',
    shape: 'Sample + method → headline finding → supporting numbers → limitation',
    questionClosing: false,
  },
  {
    style: 'comment_reply',
    label: 'Comment reply',
    guidance:
      'You are replying inside an existing thread. Answer the person actually being replied to, add one thing they did not have, and ask something back. Max 4 sentences, no self-promo in the first two.',
    shape: 'Direct answer → added detail → question back',
    questionClosing: true,
  },
];

export function blueprintFor(style: DraftStyle): StyleBlueprint {
  const found = STYLE_BLUEPRINTS.find((b) => b.style === style);
  if (!found) throw new Error(`Unknown draft style: ${style}`);
  return found;
}

/* ------------------------------------------------------------------ */
/* Offline renderer (no LLM required)                                 */
/* ------------------------------------------------------------------ */

export interface RenderContext {
  moment: ShippingMoment;
  profile: VoiceProfile;
  /** For comment replies: the comment being answered. */
  parentComment?: { author: string; body: string };
  /** For comment replies: the thread title. */
  threadTitle?: string;
  /** Subreddit the draft is targeting, when known. */
  subreddit?: string;
  linkUrl?: string | null;
  seed?: string;
  /** Distribution template id, if the caller picked one. */
  templateId?: string;
}

export interface RenderedDraft {
  title: string;
  titleVariants: string[];
  body: string;
  firstComment: string;
  flair: string;
}

const HARD_PART_FALLBACK = [
  'the part nobody warns you about',
  'the bit that took three rewrites',
  'the thing I still do not fully understand',
  'the decision I would take back',
];

/**
 * A human-readable subject for the moment.
 *
 * Tags alone make for nonsense sentences ("I finally built python postgres"), so
 * prefer the founder's own words and fall back to tags only when the moment has
 * no usable prose.
 */
const LEADING_VERBS = new Set([
  'shipped', 'built', 'released', 'fixed', 'added', 'removed', 'rewrote', 'refactored',
  'launched', 'wrote', 'made', 'switched', 'migrated', 'updated', 'improved', 'tried',
]);

function subjectOf(moment: ShippingMoment): string {
  const source = `${moment.whatChanged} ${moment.title}`;
  const words = tokenize(source).filter(
    (w) => w.length > 3 && !STOP_WORDS.has(w) && !moment.tags.includes(w),
  );
  // "shipped v2.4.0 the ingest retry" reads badly, so drop the leading verb.
  const withoutVerb = words[0] && LEADING_VERBS.has(words[0]) ? words.slice(1) : words;
  const uniqueWords = [...new Set(withoutVerb)];
  if (uniqueWords.length >= 2) return uniqueWords.slice(0, 3).join(' ');
  if (uniqueWords.length === 1) return uniqueWords[0]!;
  if (moment.tags.length > 0) return moment.tags.slice(0, 2).join('/');
  return moment.title;
}

/**
 * Shorten a fragment for a title without cutting mid-clause.
 * Prefers a sentence or clause boundary, then a word boundary.
 */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const clause = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf(', '),
    slice.lastIndexOf('; '),
    slice.lastIndexOf(' - '),
  );
  if (clause > max * 0.45) return slice.slice(0, clause).trim();
  const space = slice.lastIndexOf(' ');
  const base = space > max * 0.5 ? slice.slice(0, space) : slice;
  return base.replace(/[\s,;:.!?-]+$/, '');
}

function numberFromMoment(moment: ShippingMoment): string {
  const { commitCount, stars } = moment.source;
  if (typeof commitCount === 'number' && commitCount > 0) return String(commitCount);
  if (typeof stars === 'number' && stars > 0) return String(stars);
  return 'a few';
}

function cleanTitle(s: string): string {
  return s.replace(/\s{2,}/g, ' ').replace(/[[\]]/g, '').trim();
}

/** A Reddit title must be a complete thought, not a truncated clause. */
function titleFrom(fragment: string, max = 80): string {
  const cleaned = cleanTitle(cutAtWord(fragment.replace(/\s+/g, ' '), max));
  return cleaned.endsWith('.') || cleaned.endsWith('?') || cleaned.endsWith('!')
    ? cleaned
    : `${cleaned}.`;
}

/**
 * Deterministic composer. Used when no model is configured and as the safety
 * net when a model returns unusable output. It is voice-targeted rather than
 * generic: sentence length, formality, humor and emoji all follow the profile.
 */
export function renderDraft(context: RenderContext, style: DraftStyle): RenderedDraft {
  const { moment, profile } = context;
  const knobs = voiceKnobs(profile);
  const rand = seededRandom(context.seed ?? `${moment.id}:${style}`);
  const blueprint = blueprintFor(style);
  const template = context.templateId ? templateById(context.templateId) : undefined;
  const what = moment.whatChanged || moment.title;
  const lesson = moment.lesson;
  const hardPart = lesson || pick(HARD_PART_FALLBACK, rand);
  const n = numberFromMoment(moment);

  const paras: string[] = [];
  let titles: string[];
  let firstComment: string;

  switch (style) {
    case 'show_and_tell': {
      paras.push(`${opener(knobs, rand)} I finally built ${subjectOf(moment)}${maybeEmoji(knobs, rand)}.`);
      paras.push(`${what} ${moment.body ? moment.body.slice(0, 400) : ''}`.trim());
      paras.push(
        knobs.formality > 0.55
          ? `The most consequential decision was ${hardPart}.`
          : `the thing that ate my whole week: ${hardPart}.`,
      );
      if (template) {
        paras.push(template.guidance.split('. ').slice(0, 2).join('. ') + '.');
      }
      const closing = closer(knobs, rand, false);
      if (closing) paras.push(closing);
      titles = [
        `I built ${slugify(subjectOf(moment), 34).replace(/-/g, ' ')} — the part that broke me`,
        `Show r/${context.subreddit ?? 'SideProject'}: ${cutAtWord(what, 56)}`,
        `${titleFrom(what, 70)}${maybeEmoji(knobs, rand, ['🚀'])}`,
      ];
      firstComment = `stack: ${moment.tags.join(', ') || 'TS'}. biggest known limitation: still working on it. repo is in the post body.`;
      break;
    }
    case 'story': {
      paras.push(
        knobs.formality > 0.55
          ? `I spent longer than I planned on ${subjectOf(moment)}, and most of that time was avoidable.`
          : `spent way too long on ${subjectOf(moment)} and i want to save you the same three days.`,
      );
      paras.push(`what happened: ${what}`);
      paras.push(`the mistake: ${hardPart}.`);
      paras.push(
        knobs.formality > 0.55
          ? `What resolved it was accepting the smaller version first and expanding afterwards.`
          : `what actually fixed it was shipping the boring version first and adding the fun part later.`,
      );
      const closing = closer(knobs, rand, false);
      if (closing) paras.push(closing);
      titles = [
        `The ${n} days I lost to ${slugify(subjectOf(moment), 28).replace(/-/g, ' ')}`,
        `I screwed this up. Here is what it cost me.`,
        `${cutAtWord(hardPart, 60)} - the mistake I keep making`,
      ];
      firstComment = `if i had to redo this i would start with ${moment.tags[0] ?? 'the data model'}. happy to expand on anything.`;
      break;
    }
    case 'question': {
      paras.push(`${what}`);
      paras.push(
        knobs.formality > 0.55
          ? `I have tried ${moment.tags.slice(0, 3).join(', ') || 'a few approaches'}, but each one breaks under load.`
          : `tried ${moment.tags.slice(0, 3).join(', ') || 'a couple of things'} and every one of them falls over under load.`,
      );
      paras.push(`what i actually need is ${hardPart}.`);
      paras.push(closer(knobs, rand, true) || 'how are you handling this?');
      titles = [
        `How are you handling ${subjectOf(moment)} without it becoming a mess?`,
        `What is the cleanest way to do ${subjectOf(moment)}?`,
        `${cutAtWord(what, 56)} - what am I missing?`,
      ];
      firstComment = `for context: ${moment.tags.join(', ') || 'node + postgres'}. i have read the docs, i want to know how people actually run this in production.`;
      break;
    }
    case 'data': {
      paras.push(`ran this down across ${n} ${subjectOf(moment)} ${moment.tags[0] ?? 'items'} and the numbers are not what i expected.`);
      paras.push(`the headline: ${hardPart}.`);
      paras.push(
        knobs.formality > 0.55
          ? `Sample size is limited, and I have not controlled for ${moment.tags[1] ?? 'team size'}, so treat it as directional.`
          : `caveat: small sample and i did not control for ${moment.tags[1] ?? 'team size'}. still, the pattern is consistent.`,
      );
      paras.push(closer(knobs, rand, false) || 'happy to share the raw data if anyone wants to check the methodology.');
      titles = [
        `Analyzed ${n} ${subjectOf(moment)} — one pattern stands out`,
        `The numbers on ${subjectOf(moment)} surprised me`,
        `${n} ${subjectOf(moment)}, one clear result`,
      ];
      firstComment = `raw data + the script are linked below. methodology in a comment if anyone wants to poke holes in it.`;
      break;
    }
    case 'comment_reply': {
      const parent = context.parentComment;
      const openerWords = parent
        ? `good point${parent.body.length > 120 ? ', though' : ''} — ${knobs.formality > 0.55 ? 'to add' : 'and yeah'}:`
        : 'to add to this:';
      paras.push(openerWords);
      paras.push(`${what} ${lesson || hardPart}`);
      paras.push(closer(knobs, rand, true) || 'what does your setup look like?');
      titles = [];
      firstComment = '';
      break;
    }
  }

  const body = voiceFlavor(
    paras.filter((p) => p.trim().length > 0).join('\n\n'),
    profile,
    rand,
  );

  const flair = moment.tags[0]
    ? moment.tags[0].replace(/[-_]/g, ' ')
    : style === 'question'
      ? 'Question'
      : 'Show & Tell';

  if (style === 'comment_reply') {
    return { title: context.threadTitle ?? '', titleVariants: [], body, firstComment: '', flair };
  }

  if (titles.length === 0) titles = [titleFrom(what, 86)];
  return {
    title: cleanTitle(titles[0] ?? what),
    titleVariants: titles.slice(0, 3).map(cleanTitle),
    body,
    firstComment,
    flair,
    ...(blueprint.questionClosing ? {} : {}),
  };
}