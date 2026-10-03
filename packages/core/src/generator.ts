/**
 * Content generator.
 *
 * For every shipping moment it produces five drafts (one per style), each with:
 *   3 title variants · subreddit suggestions · flair · posting window · a first
 *   comment - and an authenticity score.
 *
 * Generation runs a repair loop: if a draft scores below the authenticity
 * threshold it is regenerated with the scorer's directives fed back as
 * instructions, up to `maxAttempts`. If it still fails, the draft is reported in
 * `rejected` rather than silently shipped - an obviously fake post is worse than
 * no post.
 */
import { scoreAuthenticity, type AuthenticityReport, rankTitleVariants } from './authenticity.js';
import { defaultSubredditPool, matchSubreddits } from './matcher.js';
import type { ModelClient } from './model.js';
import { predictBestTimes } from './scheduling.js';
import { STYLE_BLUEPRINTS, blueprintFor, renderDraft, voiceKnobs } from './templates.js';
import type {
  Draft,
  DraftSet,
  DraftStyle,
  ShippingMoment,
  SubredditProfile,
  VoiceProfile,
} from './types.js';
import { contentId, clamp, round, shortId } from './utils.js';
import { GuardrailConfigSchema } from './types.js';

export interface DraftGenerationOptions {
  userId: string;
  profile: VoiceProfile;
  /** Live subreddit profiles to match against. Falls back to a static pool. */
  subreddits?: SubredditProfile[];
  model?: ModelClient | null;
  /** Stop at these styles only. */
  styles?: DraftStyle[];
  /** Absolute ceiling on drafts per moment. */
  limit?: number;
  minAuthenticity?: number;
  /** Repair-loop attempts per style. */
  maxAttempts?: number;
  /** Where the product link goes. */
  linkUrl?: string | null;
  productName?: string | null;
  /** Subreddits the user has commented in. */
  engagedSubreddits?: string[];
  history?: string[];
  affinity?: Record<string, number>;
  styleBias?: Record<string, number>;
  seed?: string;
  now?: Date;
  /** For comment_reply style. */
  parentComment?: { author: string; body: string };
  threadTitle?: string;
}

const DEFAULT_MIN_AUTHENTICITY = 85;

/* ------------------------------------------------------------------ */
/* Prompting                                                            */
/* ------------------------------------------------------------------ */

export function buildSystemPrompt(profile: VoiceProfile): string {
  const knobs = voiceKnobs(profile);
  const traits: string[] = [];
  traits.push(`${knobs.formality > 0.55 ? 'casual and direct' : 'plain and professional'} register`);
  traits.push(`sentences averaging ~${Math.round(profile.vector.avgSentenceWords)} words`);
  traits.push(`paragraphs of ~${Math.round(profile.vector.paragraphWords)} words`);
  traits.push(knobs.humor > 0.4 ? 'frequently funny' : 'mostly earnest with occasional dry asides');
  traits.push(
    profile.vector.emojiRate < 0.8
      ? 'almost no emoji'
      : `emoji used sparingly (about ${profile.vector.emojiRate}/1000 chars)`,
  );
  if (profile.signaturePhrases.length > 0) {
    traits.push(`characteristic phrasing: ${profile.signaturePhrases.slice(0, 8).join(' / ')}`);
  }
  if (profile.favoriteWords.length > 0) {
    traits.push(`words they actually use: ${profile.favoriteWords.slice(0, 20).join(', ')}`);
  }
  if (profile.bannedWords.length > 0) {
    traits.push(`words they never use: ${profile.bannedWords.slice(0, 20).join(', ')}`);
  }

  return [
    'You write Reddit posts for a specific person. You are not an AI assistant - you are that person.',
    '',
    'VOICE (match this exactly):',
    ...traits.map((t) => `- ${t}`),
    '',
    'HARD RULES:',
    '- No corporate speak. No "delve", "leverage", "seamless", "journey", "unlock", "supercharge".',
    '- No "I hope this helps". No "let me know if you have questions". No summarizing what you just said.',
    '- Never open with a link. Links go in the final paragraph or the first comment.',
    '- Short paragraphs, blank line between them. Assume a phone screen.',
    '- Be specific: real numbers, real names, real stack choices. Invent nothing that sounds like filler.',
    '- If you do not know a number, write the sentence without it rather than making one up.',
    '',
    'Return STRICT JSON only, no prose, no code fences:',
    '{"title":"...","titleVariants":["...","...","..."],"body":"...","firstComment":"..."}',
  ].join('\n');
}

export function buildUserPrompt(
  moment: ShippingMoment,
  style: DraftStyle,
  context: {
    subreddit?: string;
    parentComment?: { author: string; body: string };
    threadTitle?: string;
    linkUrl?: string | null;
    productName?: string | null;
    directives?: string[];
  } = {},
): string {
  const blueprint = blueprintFor(style);
  const lines: string[] = [
    `POST STYLE: ${blueprint.label}`,
    `SHAPE: ${blueprint.shape}`,
    '',
    `WHAT HAPPENED (raw signal):`,
    `  kind: ${moment.kind}`,
    `  title: ${moment.title}`,
    moment.whatChanged ? `  change: ${moment.whatChanged}` : '',
    moment.body ? `  details: ${moment.body}` : '',
    moment.lesson ? `  lesson learned: ${moment.lesson}` : '',
    moment.tags.length > 0 ? `  tags: ${moment.tags.join(', ')}` : '',
    moment.source.repo ? `  repo: ${moment.source.repo}` : '',
    moment.source.url ? `  url: ${moment.source.url}` : '',
    '',
    blueprint.guidance,
  ].filter(Boolean);

  if (context.parentComment) {
    lines.push(
      '',
      `YOU ARE REPLYING IN A THREAD.`,
      `  thread: ${context.threadTitle ?? '(unknown)'}`,
      `  comment by u/${context.parentComment.author}: ${context.parentComment.body.slice(0, 400)}`,
      `  title field will be ignored for replies - put your reply in the body field.`,
    );
  }
  if (context.subreddit) {
    lines.push('', `TARGET SUBREDDIT: r/${context.subreddit}`);
  }
  if (context.productName || context.linkUrl) {
    lines.push(
      '',
      context.linkUrl
        ? `Mention ${context.productName ?? 'your project'} ONCE, and put the link ${context.subreddit ? 'in the first comment' : 'in the final paragraph'}: ${context.linkUrl}`
        : `Mention ${context.productName ?? 'your project'} at most once and do not link it.`,
    );
  }
  if (context.directives && context.directives.length > 0) {
    lines.push(
      '',
      'THE PREVIOUS ATTEMPT WAS REJECTED. Fix these specific problems:',
      ...context.directives.map((d) => `  - ${d}`),
    );
  }
  return lines.join('\n');
}

interface ParsedDraft {
  title: string;
  titleVariants: string[];
  body: string;
  firstComment: string;
}

/** Parse model output that may be wrapped in fences or contain prose around the JSON. */
export function parseDraftResponse(raw: string): ParsedDraft {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(stripped.slice(start, end + 1)) as Partial<ParsedDraft>;
      const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
      if (body.length > 0) {
        const title = (parsed.title ?? '').trim() || body.split('\n')[0]?.slice(0, 100) || 'Untitled';
        const variants = Array.isArray(parsed.titleVariants)
          ? parsed.titleVariants.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          : [];
        return {
          title,
          titleVariants: [title, ...variants.filter((v) => v !== title)].slice(0, 3),
          body,
          firstComment: typeof parsed.firstComment === 'string' ? parsed.firstComment.trim() : '',
        };
      }
    } catch {
      // Malformed JSON is common enough (unescaped newlines, trailing commas)
      // that a field-level extraction is worth having before giving up.
      const lenient = lenientFieldExtract(stripped);
      if (lenient) return lenient;
    }
  }

  // Non-JSON response: treat everything as the body and derive a title.
  const body = stripped.trim();
  const firstLine = body.split('\n')[0]?.replace(/^#+\s*/, '').trim() ?? '';
  return {
    title: firstLine.slice(0, 120),
    titleVariants: firstLine ? [firstLine.slice(0, 120)] : ['Untitled'],
    body,
    firstComment: '',
  };
}

/** Pull `body` / `title` out of a JSON-ish string whose overall syntax is broken. */
function lenientFieldExtract(source: string): ParsedDraft | null {
  const readField = (field: string): string | undefined => {
    const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's').exec(source);
    if (!match?.[1]) return undefined;
    return match[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
  };

  const body = readField('body');
  if (!body || body.length === 0) return null;
  const title = readField('title') ?? body.split('\n')[0]?.replace(/^#+\s*/, '').trim() ?? '';
  const firstComment = readField('firstComment') ?? '';
  const variants = [...source.matchAll(/"titleVariants"\s*:\s*\[([^\]]*)\]/gs)]
    .flatMap((m) => [...(m[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((v) => v[1] ?? ''))
    .filter(Boolean);

  return {
    title: title || 'Untitled',
    titleVariants: [title || 'Untitled', ...variants.filter((v) => v !== title)].slice(0, 3),
    body,
    firstComment,
  };
}

/* ------------------------------------------------------------------ */
/* Generation                                                           */
/* ------------------------------------------------------------------ */

export async function generateDraftSet(
  moment: ShippingMoment,
  options: DraftGenerationOptions,
): Promise<DraftSet> {
  const minScore = options.minAuthenticity ?? DEFAULT_MIN_AUTHENTICITY;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const guardrail = GuardrailConfigSchema.parse({});
  void guardrail;

  const pool = options.subreddits?.length ? options.subreddits : defaultSubredditPool();
  const styles: DraftStyle[] =
    options.styles ?? STYLE_BLUEPRINTS.map((b) => b.style);
  const now = options.now ?? new Date();

  const drafts: Draft[] = [];
  const rejected: DraftSet['rejected'] = [];

  for (const style of styles) {
    if (drafts.length >= (options.limit ?? styles.length)) break;
    // A comment reply is meaningless without the thread it belongs to, so we
    // report it instead of inventing a context.
    if (style === 'comment_reply' && !options.parentComment) {
      rejected.push({
        style,
        reason:
          'no thread context supplied - comment replies are generated when someone comments on one of your published posts',
        bestScore: 0,
      });
      continue;
    }
    const result = await generateOneStyle(moment, style, {
      ...options,
      pool,
      minScore,
      maxAttempts,
      now,
    });
    if (result.draft) drafts.push(result.draft);
    else rejected.push(result.rejection);
  }

  // Rank by authenticity so the founder opens the queue on the strongest draft.
  drafts.sort((a, b) => b.authenticityScore - a.authenticityScore);

  return {
    momentId: moment.id,
    drafts,
    rejected,
    voiceProfileId: options.profile.id,
    generatedAt: now.toISOString(),
  };
}

interface OneStyleArgs extends DraftGenerationOptions {
  pool: SubredditProfile[];
  minScore: number;
  maxAttempts: number;
  now: Date;
}

async function generateOneStyle(
  moment: ShippingMoment,
  style: DraftStyle,
  args: OneStyleArgs,
): Promise<{ draft: Draft | null; rejection: DraftSet['rejected'][number] }> {
  const system = buildSystemPrompt(args.profile);
  const seed = args.seed ?? `${moment.id}:${style}:${args.profile.id}`;
  let directives: string[] = [];
  let best: { content: ParsedDraft; report: AuthenticityReport } | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt < args.maxAttempts; attempt++) {
    attempts = attempt + 1;
    const content = await composeContent(moment, style, system, seed, attempt, directives, args);
    const report = scoreAuthenticity(
      style === 'comment_reply' ? content.body : `${content.title}\n\n${content.body}`,
      args.profile,
      { threshold: args.minScore },
    );

    if (!best || report.score > best.report.score) best = { content, report };
    if (report.passed) {
      return { draft: buildDraft(moment, style, content, report, args, attempts), rejection: null! };
    }
    directives = report.directives.slice(0, 6);
  }

  return {
    draft: null,
    rejection: {
      style,
      reason: `never reached ${args.minScore} after ${attempts} attempts (best ${round(best?.report.score ?? 0, 1)})`,
      bestScore: round(best?.report.score ?? 0, 1),
    },
  };
}

async function composeContent(
  moment: ShippingMoment,
  style: DraftStyle,
  system: string,
  seed: string,
  attempt: number,
  directives: string[],
  args: OneStyleArgs,
): Promise<ParsedDraft> {
  const offline = renderDraft(
    {
      moment,
      profile: args.profile,
      seed: `${seed}:${attempt}`,
      ...(args.parentComment ? { parentComment: args.parentComment } : {}),
      ...(args.threadTitle ? { threadTitle: args.threadTitle } : {}),
      ...(args.linkUrl ? { linkUrl: args.linkUrl } : {}),
      ...(args.productName ? { templateId: 'show_subreddit' } : {}),
    },
    style,
  );

  if (!args.model) {
    return {
      title: offline.title,
      titleVariants: offline.titleVariants,
      body: offline.body,
      firstComment: offline.firstComment,
    };
  }

  const userPrompt = buildUserPrompt(moment, style, {
    ...(args.parentComment ? { parentComment: args.parentComment } : {}),
    ...(args.threadTitle ? { threadTitle: args.threadTitle } : {}),
    ...(args.linkUrl ? { linkUrl: args.linkUrl } : {}),
    ...(args.productName ? { productName: args.productName } : {}),
    directives,
  });

  try {
    const result = await args.model.generate(system, userPrompt, {
      temperature: 0.75 + attempt * 0.1,
      maxTokens: 1400,
    });
    const parsed = parseDraftResponse(result.text);
    if (parsed.body.length < 40) throw new Error('model body too short');
    return {
      ...parsed,
      // Keep the offline renderer's flair and first comment when the model omits them.
      firstComment: parsed.firstComment || offline.firstComment,
    };
  } catch {
    // Model unavailable or unusable output: the deterministic composer keeps us shipping.
    return {
      title: offline.title,
      titleVariants: offline.titleVariants,
      body: offline.body,
      firstComment: offline.firstComment,
    };
  }
}

function buildDraft(
  moment: ShippingMoment,
  style: DraftStyle,
  content: ParsedDraft,
  report: AuthenticityReport,
  args: OneStyleArgs,
  attempts: number,
): Draft {
  const id = contentId(`${args.userId}:${moment.id}:${style}:${Date.now()}`);
  const suggestions = matchSubreddits(
    args.pool,
    {
      title: content.title,
      body: content.body,
      firstComment: content.firstComment,
      ...(args.linkUrl ? { linkUrl: args.linkUrl } : {}),
      ...(args.productName ? { productName: args.productName } : {}),
      style,
    },
    {
      ...(args.engagedSubreddits ? { history: args.engagedSubreddits } : {}),
      ...(args.affinity ? { affinity: args.affinity } : {}),
      ...(args.styleBias ? { styleBias: args.styleBias } : {}),
      limit: 3,
    },
  );

  const primary = suggestions[0]?.subreddit ?? null;
  const profile = primary ? args.pool.find((p) => p.name === primary) : undefined;
  const slots = profile ? predictBestTimes(profile, { count: 1, now: args.now }) : [];
  const flair = pickFlair(content, profile);

  const variants = content.titleVariants.length > 0 ? content.titleVariants : [content.title];
  const ranked = rankTitleVariants(variants, content.body, args.profile);
  const bestTitle = ranked[0]?.title ?? content.title;

  const timestamp = args.now.toISOString();
  return {
    id,
    userId: args.userId,
    momentId: moment.id,
    style,
    status: 'review',
    title: bestTitle,
    titleVariants: variants,
    selectedTitleVariant: variants.indexOf(bestTitle),
    body: content.body,
    firstComment: content.firstComment,
    flair,
    flairId: null,
    linkUrl: args.linkUrl ?? null,
    suggestedSubreddits: suggestions,
    primarySubreddit: primary,
    authenticityScore: report.score,
    authenticity: report.breakdown as unknown as Record<string, number>,
    authenticityNotes: report.notes.slice(0, 6),
    editCount: 0,
    scheduledFor: slots[0]?.at ?? null,
    postedAt: null,
    redditId: null,
    permalink: null,
    generator: {
      template: style,
      model: args.model?.name ?? 'offline-composer',
      seed: args.seed ?? moment.id,
      attempt: attempts - 1,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function pickFlair(content: ParsedDraft, profile: SubredditProfile | undefined): string {
  if (profile?.flairs.length) {
    const body = content.body.toLowerCase();
    const scored = profile.flairs
      .map((flair) => {
        const words = flair.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const hits = words.filter((w) => body.includes(w)).length;
        return { text: flair.text, hits };
      })
      .sort((a, b) => b.hits - a.hits);
    const best = scored[0];
    if (best && best.hits > 0) return best.text;
    return profile.flairs[0]?.text ?? '';
  }
  return '';
}

/**
 * Regenerate a single draft with extra directives - this is what the dashboard
 * "make it sound more like me" button calls.
 */
export async function regenerateDraft(
  moment: ShippingMoment,
  draft: Draft,
  extraDirectives: readonly string[],
  args: DraftGenerationOptions,
): Promise<{ draft: Draft; report: AuthenticityReport }> {
  const report = scoreAuthenticity(`${draft.title}\n\n${draft.body}`, args.profile, {
    threshold: args.minAuthenticity ?? DEFAULT_MIN_AUTHENTICITY,
  });
  const directives = [...new Set([...report.directives, ...extraDirectives])].slice(0, 8);
  const content = await composeContent(moment, draft.style, buildSystemPrompt(args.profile), draft.id, 1, directives, {
    ...args,
    pool: args.subreddits?.length ? args.subreddits : defaultSubredditPool(),
    minScore: args.minAuthenticity ?? DEFAULT_MIN_AUTHENTICITY,
    maxAttempts: args.maxAttempts ?? 3,
    now: args.now ?? new Date(),
  });
  const newReport = scoreAuthenticity(`${content.title}\n\n${content.body}`, args.profile, {
    threshold: args.minAuthenticity ?? DEFAULT_MIN_AUTHENTICITY,
  });
  return {
    draft: buildDraft(moment, draft.style, content, newReport, {
      ...args,
      pool: args.subreddits?.length ? args.subreddits : defaultSubredditPool(),
      minScore: args.minAuthenticity ?? DEFAULT_MIN_AUTHENTICITY,
      maxAttempts: args.maxAttempts ?? 3,
      now: args.now ?? new Date(),
    }, 2),
    report: newReport,
  };
}

/**
 * Suggest a reply to a comment on one of our posts. Same voice gate as posts,
 * but scored with `platformNative: false` since a comment is not a standalone post.
 */
export async function suggestReply(
  comment: { author: string; body: string },
  post: { title: string; subreddit: string },
  profile: VoiceProfile,
  options: { model?: ModelClient | null; seed?: string } = {},
): Promise<{ reply: string; score: number; notes: string[] }> {
  const moment: ShippingMoment = {
    id: shortId('reply'),
    kind: 'manual',
    title: post.title,
    body: comment.body,
    whatChanged: '',
    lesson: '',
    tags: [post.subreddit],
    source: {},
    createdAt: new Date().toISOString(),
  };
  const rendered = renderDraft(
    { moment, profile, seed: options.seed ?? comment.body.slice(0, 40), parentComment: comment, threadTitle: post.title, subreddit: post.subreddit },
    'comment_reply',
  );

  let body = rendered.body;
  if (options.model) {
    const system = [
      'You are replying to a comment on your own Reddit post.',
      'Answer the person directly, add one thing they did not have, ask something back.',
      'Maximum 4 sentences. No self-promotion in the first two. Never mention that you are an AI.',
      'Return only the reply text.',
    ].join('\n');
    try {
      const result = await options.model.generate(
        system,
        `Post: ${post.title}\nu/${comment.author} wrote: ${comment.body}`,
        { temperature: 0.8, maxTokens: 300 },
      );
      if (result.text.trim().length > 20) body = result.text.trim();
    } catch {
      /* keep the deterministic reply */
    }
  }

  const report = scoreAuthenticity(body, profile, { platformNative: false });
  return { reply: body, score: report.score, notes: report.directives };
}

/** Build a Shippable moment from free text - the manual draft entry point. */
export function momentFromText(text: string, tags: string[] = []): ShippingMoment {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const title = lines[0]?.slice(0, 140) ?? text.slice(0, 140);
  const rest = lines.slice(1);
  const lessonIdx = rest.findIndex((l) => /^(lesson|takeaway|learned|so|turns out)\b/i.test(l));
  const lesson = lessonIdx >= 0 ? (rest[lessonIdx] ?? '').replace(/^(lesson|takeaway|learned|so|turns out)\s*:\s*/i, '') : '';
  const body = (lessonIdx >= 0 ? rest.filter((_, i) => i !== lessonIdx) : rest).join('\n');

  return {
    id: shortId('mom'),
    kind: 'manual',
    title,
    body,
    whatChanged: body || title,
    lesson,
    tags,
    source: {},
    createdAt: new Date().toISOString(),
  };
}

/** Style performance multiplier used by the learning loop, 0-1. */
export function styleBiasFromResults(
  results: ReadonlyArray<{ subreddit: string; style: DraftStyle; engagement: number }>,
): Record<string, number> {
  const perSub = new Map<string, { sum: number; count: number }>();
  let max = 0;
  for (const r of results) max = Math.max(max, r.engagement);
  if (max === 0) return {};

  for (const r of results) {
    const key = `${r.subreddit}::${r.style}`;
    const entry = perSub.get(key) ?? { sum: 0, count: 0 };
    entry.sum += clamp(r.engagement / max);
    entry.count += 1;
    perSub.set(key, entry);
  }

  const bias: Record<string, number> = {};
  for (const [key, { sum, count }] of perSub) {
    bias[key] = round(sum / Math.max(count, 1), 3);
  }
  // The matcher expects subreddit-level scores, so keep the max style per subreddit.
  const bySubreddit: Record<string, number> = {};
  for (const [key, value] of Object.entries(bias)) {
    const [subreddit] = key.split('::');
    if (!subreddit) continue;
    bySubreddit[subreddit] = Math.max(bySubreddit[subreddit] ?? 0, value);
  }
  return bySubreddit;
}
