/**
 * Subreddit rules parser.
 *
 * Reddit has no structured rules endpoint, so we read the sidebar / about text and
 * infer machine-checkable constraints. Every inference records the sentence that
 * produced it, so the dashboard can show the founder *why* a draft was blocked.
 */
import type { SubredditProfile, SubredditRule } from './types.js';
import { round, unique } from './utils.js';

/** Strip HTML down to readable text without pulling in a DOM parser. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

interface RulePattern {
  kind: SubredditRule['kind'];
  severity: SubredditRule['severity'];
  patterns: RegExp[];
  /** Extracts the numeric/string value from the matched sentence. */
  value?: (sentence: string) => string | number | boolean | undefined;
  description: string;
}

function extractNumber(sentence: string, unit: RegExp): number | undefined {
  const match = sentence.match(new RegExp(`(\\d+)\\s*${unit.source}`, 'i'));
  return match?.[1] ? Number(match[1]) : undefined;
}

function extractTitleLength(sentence: string): number | undefined {
  const match = sentence.match(/(\d{2,3})\s*(?:character|char)/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

const RULE_PATTERNS: RulePattern[] = [
  {
    kind: 'no_selfpromo',
    severity: 'hard',
    description: 'No self-promotion',
    patterns: [
      /\bno[-\s]?(?:self[-\s]?promo\w*|promotional?\s+posts?|marketing|advertis\w+|hype|shill\w*)\b/i,
      /\bself[-\s]?promotion\b.{0,40}\b(not allowed|prohibited|banned|disallowed)\b/i,
    ],
  },
  {
    kind: 'no_links',
    severity: 'hard',
    description: 'No external links',
    patterns: [
      /\bno[-\s]?(?:external\s+)?links?\b/i,
      /\blinks?\b.{0,30}\b(?:not allowed|prohibited|banned|disallowed|no)\b/i,
    ],
  },
  {
    kind: 'no_external_link_first_paragraph',
    severity: 'soft',
    description: 'Links belong in a comment, not the post body',
    patterns: [
      /\b(?:link|url)s?\b.{0,40}\b(?:in the comments?|comments? section)\b/i,
      /\bno\s+(?:direct\s+)?links?\b.{0,30}\bbody\b/i,
      /\b(?:blog|article)\.?s?\b.{0,20}\bin the comments\b/i,
    ],
  },
  {
    kind: 'flair_required',
    severity: 'hard',
    description: 'Every post must have flair',
    value: () => true,
    patterns: [
      /\bflair\b.{0,30}\b(?:required|mandatory|must)\b/i,
      /\b(?:must|please)\s+(?:select|choose|add|set)\s+(?:the\s+right\s+)?flair\b/i,
      /\ball posts must be flaired\b/i,
    ],
  },
  {
    kind: 'title_format',
    severity: 'hard',
    description: 'Title must follow the required format',
    patterns: [
      /\btitles?\b.{0,40}\b(?:must|should|need to|have to)\b/i,
      /\bformat\b.{0,20}\btitles?\b/i,
      /\btitle\b.{0,20}\b\[.{0,40}\]/i,
    ],
  },
  {
    kind: 'no_markdown',
    severity: 'soft',
    description: 'Plain text posts only',
    patterns: [/\bno\s+markdown\b/i, /\bmarkdown\b.{0,20}\bnot (?:allowed|supported)\b/i],
  },
  {
    kind: 'karma_age',
    severity: 'hard',
    description: 'Account must meet a karma threshold',
    value: (s) => extractNumber(s, /(?:account\s+)?karma/i),
    patterns: [/\b\d+\s*karma\b/i, /\bkarma\b.{0,40}\b(?:required|minimum|threshold)\b/i],
  },
  {
    kind: 'min_account_age_days',
    severity: 'hard',
    description: 'Account must be at least N days old',
    value: (s) => {
      const months = s.match(/(\d+)\s*months?/i);
      if (months?.[1]) return Number(months[1]) * 30;
      return extractNumber(s, /days?/i);
    },
    patterns: [
      /\baccount age\b/i,
      /\b\d+\s*(?:days?|months?)\s+old\b/i,
      /\bnew(?:er)? accounts?\b.{0,30}\b(?:may not|cannot|are not allowed|do not)\b/i,
    ],
  },
  {
    kind: 'weekly_post_limit',
    severity: 'hard',
    description: 'Limited number of posts per week',
    value: (s) => extractNumber(s, /(?:per|each)\s+(?:day|week|month)/i),
    patterns: [
      /\b(?:one|1|two|2|three|3)\s+post\b.{0,30}\bper\s+(?:day|week|month)\b/i,
      /\bpost limit\b/i,
      /\b(?:max|maximum|limit of)\b.{0,20}\bposts?\b/i,
    ],
  },
  {
    kind: 'title_length',
    severity: 'soft',
    description: 'Title length limit',
    value: extractTitleLength,
    patterns: [/\btitles?\b.{0,30}\b(\d{2,3})\s*(?:character|char)/i],
  },
  {
    kind: 'no_crosspost',
    severity: 'soft',
    description: 'No crossposts',
    patterns: [/\bno\s+crossposts?\b/i, /\bcrossposts?\b.{0,30}\b(?:not allowed|prohibited)\b/i],
  },
  {
    kind: 'text_only',
    severity: 'soft',
    description: 'Text posts only (no link posts)',
    patterns: [/\btext (?:posts? )?only\b/i, /\bno\s+link\s+posts?\b/i],
  },
];

/**
 * Split rule-ish text into candidate sentences.
 *
 * Only breaks after real sentence-ending punctuation that follows a word, so
 * list numbering (1. Crossposts) and phrases without punctuation
 * (No self promotion) both survive intact.
 */
function ruleSentences(text: string): string[] {
  const SENTENCE_BREAK = /(?<=[\p{L})\]\x22\x27])[.!?]+(?:\s+|$)/u;
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(SENTENCE_BREAK))
    .map((s) => s.trim())
    .filter((s) => s.length > 3 && s.length < 400);
}

export interface ParsedRules {
  rules: SubredditRule[];
  /** Sections that look like actual numbered rules — used to weight severity. */
  ruleSections: string[];
}

/** Parse free-form sidebar/about text into structured, checkable rules. */
export function parseRules(...sources: Array<string | null | undefined>): ParsedRules {
  const text = sources.filter((s): s is string => Boolean(s)).map((s) => htmlToText(s)).join('\n');
  const sentences = ruleSentences(text);
  const rules: SubredditRule[] = [];
  const seen = new Set<string>();

  // Numbered / bulleted rule lines are the canonical rules; mark them so
  // severity escalates when a soft phrasing shows up inside a numbered list.
  const ruleSections = sentences.filter(
    (s) => /^\s*(?:\d+[.)]|[-*•]|rule\s*\d+)/i.test(s) && s.length > 8,
  );

  for (const sentence of sentences) {
    for (const pattern of RULE_PATTERNS) {
      if (seen.has(pattern.kind)) continue;
      const matched = pattern.patterns.some((p) => p.test(sentence));
      if (!matched) continue;
      seen.add(pattern.kind);
      const isExplicitRule = ruleSections.some((r) => r === sentence);
      rules.push({
        id: `${pattern.kind}`,
        kind: pattern.kind,
        description: pattern.description,
        severity: isExplicitRule && pattern.severity === 'soft' ? 'hard' : pattern.severity,
        ...(pattern.value?.(sentence) !== undefined ? { value: pattern.value(sentence) } : {}),
      });
    }
  }

  // "no links at all" implies link-in-comment only.
  const hasNoLinks = rules.some((r) => r.kind === 'no_links');
  if (hasNoLinks && !rules.some((r) => r.kind === 'no_external_link_first_paragraph')) {
    rules.push({
      id: 'no_external_link_first_paragraph',
      kind: 'no_external_link_first_paragraph',
      description: 'Links belong in a comment, not the post body',
      severity: 'hard',
      value: true,
    });
  }

  return { rules, ruleSections };
}

/* ------------------------------------------------------------------ */
/* Topic / category inference                                           */
/* ------------------------------------------------------------------ */

export interface TopicDefinition {
  category: string;
  subreddits: string[];
  keywords: string[];
  /** Categories where a founder's product plug is a rule violation. */
  noSelfPromo?: boolean;
}

export const TOPIC_DEFINITIONS: TopicDefinition[] = [
  {
    category: 'programming',
    subreddits: ['programming', 'ExperiencedDevs', 'learnprogramming', 'SoftwareEngineering'],
    keywords: ['refactor', 'compiler', 'type system', 'rust', 'c++', 'zig', 'linter', 'build', 'repo', 'pr', 'bug', 'stack', 'api'],
  },
  {
    category: 'webdev',
    subreddits: ['webdev', 'webdevelopment', 'Frontend', 'javascript', 'typescript', 'CSS', 'reactjs'],
    keywords: ['frontend', 'css', 'react', 'next.js', 'nextjs', 'tailwind', 'hydration', 'ssr', 'dom', 'browser', 'html', 'responsive'],
  },
  {
    category: 'selfhosted',
    subreddits: ['selfhosted', 'homelab', 'self-hosted', 'Docker'],
    keywords: ['self-host', 'selfhost', 'docker', 'compose', 'nginx', 'homelab', 'raspberry pi', 'synology', 'reverse proxy', 'postgresql', 'sqlite'],
  },
  {
    category: 'sideproject',
    subreddits: ['SideProject', 'webdev', 'indiehackers', 'dev'],
    keywords: ['side project', 'sideproject', 'weekend project', 'pet project', 'built', 'launch', 'portfolio'],
  },
  {
    category: 'indiehackers',
    subreddits: ['indiehackers', 'IndieHackers', 'SaaS', 'startups', 'Entrepreneur', 'smallbusiness'],
    keywords: ['mrr', 'arr', 'churn', 'pricing', 'revenue', 'customers', 'saas', 'boilerplate', 'landing page', 'churn rate', 'user interviews'],
  },
  {
    category: 'devops',
    subreddits: ['devops', 'kubernetes', 'terraform', 'aws', 'sre', 'observability'],
    keywords: ['kubernetes', 'k8s', 'terraform', 'pipeline', 'ci/cd', 'deploy', 'prometheus', 'grafana', 'scaling', 'incident'],
  },
  {
    category: 'data',
    subreddits: ['datascience', 'data', 'ExperiencedDevs', 'SQL', 'analytics'],
    keywords: ['dataset', 'analytics', 'sql', 'query', 'metrics', 'etl', 'pandas', 'data pipeline'],
  },
  {
    category: 'ai',
    subreddits: ['LocalLLaMA', 'MachineLearning', 'artificial', 'ChatGPT', 'singularity', 'promptengineering'],
    keywords: ['llm', 'gpt', 'claude', 'embedding', 'rag', 'fine-tune', 'inference', 'transformer', 'agent', 'prompt'],
  },
  {
    category: 'security',
    subreddits: ['netsec', 'security', 'networking', 'crypto'],
    keywords: ['vulnerability', 'cve', 'auth', 'encryption', 'threat model', 'patch', 'xss', 'csrf'],
  },
  {
    category: 'career',
    subreddits: [' ExperiencedDevs', 'cscareerquestions', 'dev', 'remotejs', 'freelance'],
    keywords: ['interview', 'offer', 'salary', 'junior', 'senior', 'burnout', 'quit', 'remote work'],
  },
  {
    category: 'hardware',
    subreddits: ['hardware', 'embedded', 'raspberry_pi', 'MechanicalKeyboards'],
    keywords: ['esp32', 'arduino', 'pcb', 'sensor', 'fpga', 'device'],
  },
];

/** Categories we must never post marketing-adjacent content into. */
export const DEFAULT_AVOID_CATEGORIES = ['nsfw', 'politics', 'military', 'animals_only'];

const NSFW_TOKENS = ['nsfw', 'onlysfw', 'violence', 'gore'];

export interface TopicInference {
  categories: Array<{ category: string; score: number }>;
  subreddits: string[];
  topics: string[];
  avoidCategories: string[];
}

export function inferTopics(text: string): TopicInference {
  const haystack = text.toLowerCase();
  const categories: Array<{ category: string; score: number }> = [];

  for (const def of TOPIC_DEFINITIONS) {
    let score = 0;
    for (const keyword of def.keywords) {
      if (haystack.includes(keyword.toLowerCase())) score += keyword.includes(' ') ? 2 : 1;
    }
    if (score > 0) categories.push({ category: def.category, score });
  }
  categories.sort((a, b) => b.score - a.score);

  const subreddits = unique(
    categories.flatMap((c) => TOPIC_DEFINITIONS.find((d) => d.category === c.category)?.subreddits ?? []),
  );
  const topics = categories.slice(0, 5).map((c) => c.category);

  const avoidCategories = [
    ...NSFW_TOKENS.filter((t) => haystack.includes(t)),
    ...categories.filter((c) => DEFAULT_AVOID_CATEGORIES.includes(c.category)).map((c) => c.category),
  ];

  return { categories, subreddits: subreddits.slice(0, 12), topics, avoidCategories: unique(avoidCategories) };
}

/** Activity score 0-100 from subscribers + activity-by-hour, used for ranking. */
export function computeActivityScore(profile: SubredditProfile): number | null {
  if (profile.activity !== null && profile.activity !== undefined) return profile.activity;
  const subscribers = profile.subscribers ?? 0;
  if (subscribers === 0) return null;

  let score = 0;
  // Log scale: 1k subs and 500k subs are both "big enough to matter".
  const sizeScore = Math.min(100, (Math.log10(Math.max(subscribers, 1)) - 2.5) * 26);
  score += Math.max(0, sizeScore);

  if (profile.postsPerDay) score += Math.min(15, profile.postsPerDay * 1.5);
  if (profile.upvoteRatio) score += (profile.upvoteRatio - 0.85) * 60;

  const hourly = profile.activityByHourUtc.filter((n) => typeof n === 'number');
  if (hourly.length === 24) {
    const peak = Math.max(...hourly);
    const meanValue = hourly.reduce((a, b) => a + b, 0) / 24;
    if (meanValue > 0) score += Math.min(15, ((peak - meanValue) / meanValue) * 8);
  }

  if (profile.over18 || profile.quarantined) score *= 0.5;
  if (profile.restricted) score *= 0.25;

  return round(Math.max(0, Math.min(100, score)));
}

/** Build a SubredditProfile from a raw `/r/x/about.json` + `/about/sidebar.json` payload. */
export function profileFromRedditJson(
  name: string,
  data: {
    display_name?: string;
    subscribers?: number;
    active_user_count?: number;
    public_description?: string;
    description?: string;
    over18?: boolean;
    restricted?: boolean;
    quarantine?: boolean;
    average_upvote_ratio?: number;
    posts_per_hour?: number;
  },
  sidebar = '',
): SubredditProfile {
  const sidebarText = htmlToText(sidebar);
  const aboutText = htmlToText(`${data.public_description ?? ''}\n${data.description ?? ''}`);
  const combined = `${sidebarText}\n${aboutText}`;
  const parsed = parseRules(sidebarText, aboutText);
  const topics = inferTopics(combined);

  const profile: SubredditProfile = {
    name: data.display_name ?? name,
    displayName: data.display_name ?? name,
    subscribers: data.subscribers ?? null,
    activeUsers: data.active_user_count ?? null,
    activity: null,
    upvoteRatio: data.average_upvote_ratio ?? null,
    postsPerDay: typeof data.posts_per_hour === 'number' ? data.posts_per_hour * 24 : null,
    over18: data.over18 ?? false,
    restricted: data.restricted ?? false,
    quarantined: data.quarantine ?? false,
    description: aboutText,
    sidebar: sidebarText,
    rules: parsed.rules,
    flairs: [],
    activityByHourUtc: [],
    topics: topics.topics,
    allowSelfPromo: !parsed.rules.some((r) => r.kind === 'no_selfpromo' && r.severity === 'hard'),
    allowLinks: !parsed.rules.some((r) => r.kind === 'no_links' && r.severity === 'hard'),
    requiresFlair: parsed.rules.some((r) => r.kind === 'flair_required'),
    fetchedAt: new Date().toISOString(),
  };
  profile.activity = computeActivityScore(profile);
  return profile;
}