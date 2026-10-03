/**
 * Subreddit matcher.
 *
 * Ranks candidate subreddits for a draft on four axes and then runs a compliance
 * check. A draft that violates a hard rule is never "top ranked" — it is marked
 * non-compliant so the dashboard can show exactly what needs fixing.
 */
import { DEFAULT_AVOID_CATEGORIES, inferTopics } from './subreddit.js';
import type { SubredditProfile, SubredditSuggestion } from './types.js';
import { clamp, round, unique } from './utils.js';

export interface ComplianceInput {
  title: string;
  body: string;
  firstComment: string;
  /** Text the draft would push: a product link or product name. */
  linkUrl?: string | null;
  productName?: string | null;
  accountAgeDays?: number;
  accountKarma?: number;
}

export interface ComplianceResult {
  violations: string[];
  compliance: string[];
  compliant: boolean;
}

const PROMO_PATTERNS = [
  /\b(?:check (?:out|take a look at)|try it|sign up|use my|my tool|my app|my saas|my product)\b/i,
  /\bhttps?:\/\/\S+/i,
  /\b\d+%\s*(?:off|discount)\b/i,
  /\b(?:dm me|comment "?i'?ll" send|link in bio)\b/i,
];

const AI_TELL_LINK_FRAMING = /\b(read more|full article|blog post|check out the post)\b/i;

/**
 * Check a draft against a subreddit's rules.
 * Returns human-readable violations with the exact rule that produced them.
 */
export function checkCompliance(
  profile: SubredditProfile,
  draft: ComplianceInput,
): ComplianceResult {
  const violations: string[] = [];
  const compliance: string[] = [];
  const combined = `${draft.title}\n\n${draft.body}`;

  if (profile.restricted) {
    return {
      violations: [`r/${profile.name} is restricted — only approved users can post`],
      compliance: [],
      compliant: false,
    };
  }
  if (profile.quarantined) {
    violations.push(`r/${profile.name} is quarantined — account needs to opt in via reddit.com settings`);
  }

  for (const rule of profile.rules) {
    switch (rule.kind) {
      case 'no_links': {
        const hasLink = /https?:\/\//.test(combined);
        if (hasLink) {
          violations.push(
            `r/${profile.name} bans links in posts — move the URL to your first comment`,
          );
        } else {
          compliance.push('No links in the post body');
        }
        break;
      }
      case 'no_external_link_first_paragraph': {
        const firstParagraph = (draft.body.split(/\n{2,}/)[0] ?? '').trim();
        if (/https?:\/\//.test(firstParagraph)) {
          violations.push(
            `r/${profile.name} requires links in the comments, not the first paragraph`,
          );
        }
        break;
      }
      case 'no_selfpromo': {
        const promoHits = PROMO_PATTERNS.filter((p) => p.test(combined));
        const namesProduct =
          Boolean(draft.productName) &&
          new RegExp(draft.productName!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(combined);
        if (namesProduct || promoHits.length > 0) {
          violations.push(
            `r/${profile.name} bans self-promotion — remove the product mention and any link (leave it in your first comment)`,
          );
        } else {
          compliance.push('No self-promotion detected');
        }
        if (AI_TELL_LINK_FRAMING.test(combined)) {
          violations.push('Remove "read more" / "full article" framing — it reads as marketing');
        }
        break;
      }
      case 'flair_required': {
        compliance.push('Flair required — suggestion included in the draft');
        break;
      }
      case 'title_format': {
        const bracket = profile.rules.find((r) => r.kind === 'title_format')?.value;
        if (typeof bracket === 'string' && bracket && !draft.title.includes(bracket)) {
          violations.push(`r/${profile.name} requires "${bracket}" in the title`);
        }
        break;
      }
      case 'title_length': {
        const limit = Number(rule.value ?? 0);
        if (limit > 0 && draft.title.length > limit) {
          violations.push(`Title is ${draft.title.length} characters; r/${profile.name} caps at ${limit}`);
        } else if (limit > 0) {
          compliance.push(`Title within the ${limit}-character limit`);
        }
        break;
      }
      case 'no_markdown': {
        if (/^\s*[-*•]\s+/m.test(draft.body) || /```/.test(draft.body) || /^\s*#{1,6}\s/m.test(draft.body)) {
          violations.push(`r/${profile.name} is plain-text only — remove markdown formatting`);
        }
        break;
      }
      case 'text_only': {
        if (draft.linkUrl) {
          violations.push(`r/${profile.name} is text-posts-only — do not submit a link post`);
        }
        break;
      }
      case 'karma_age': {
        const required = Number(rule.value ?? 0);
        if (required > 0 && (draft.accountKarma ?? 0) < required) {
          violations.push(
            `r/${profile.name} requires ${required}+ account karma (you have ${draft.accountKarma ?? 0}) — post elsewhere for now`,
          );
        } else if (required > 0) {
          compliance.push(`Karma requirement met (${required})`);
        }
        break;
      }
      case 'min_account_age_days': {
        const required = Number(rule.value ?? 0);
        if (required > 0 && (draft.accountAgeDays ?? 0) < required) {
          violations.push(
            `r/${profile.name} requires a ${required}-day-old account (you have ${draft.accountAgeDays ?? 0})`,
          );
        } else if (required > 0) {
          compliance.push(`Account age requirement met (${required} days)`);
        }
        break;
      }
      case 'weekly_post_limit': {
        compliance.push(
          `r/${profile.name} limits posts per week — Upvote tracks this and will hold the next one`,
        );
        break;
      }
      case 'no_crosspost': {
        violations.push(`r/${profile.name} disallows crossposts — submit as an original post`);
        break;
      }
      case 'custom':
      default:
        break;
    }
  }

  // Local safety rail: never route marketing-flavoured copy into sensitive subs.
  for (const category of DEFAULT_AVOID_CATEGORIES) {
    if (profile.topics.includes(category)) {
      violations.push(`r/${profile.name} is in the ${category} avoid-category`);
    }
  }

  return {
    violations: unique(violations),
    compliance: unique(compliance),
    compliant: violations.filter((v) => !v.toLowerCase().includes('will hold')).length === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Ranking                                                              */
/* ------------------------------------------------------------------ */

export interface MatchOptions {
  /** Subreddits the user has actually commented in before — a real trust signal. */
  history?: string[];
  /** Explicit user preference, 0-1. */
  affinity?: Record<string, number>;
  blocklist?: string[];
  avoidCategories?: string[];
  /** Learned from the analytics loop: subreddit -> style performance multiplier. */
  styleBias?: Record<string, number>;
  style?: string;
  limit?: number;
}

/**
 * Score one subreddit for one draft. Returns 0-100.
 *
 * Signals, in descending weight:
 *   topic overlap (0.40) · size/activity fit (0.20) · history/affinity (0.15)
 *   · rule friendliness (0.15) · style performance (0.10)
 */
export function scoreSubreddit(
  profile: SubredditProfile,
  draftText: string,
  options: MatchOptions = {},
): { fit: number; reasons: string[] } {
  const reasons: string[] = [];
  const nameLower = profile.name.toLowerCase();
  if ((options.blocklist ?? []).some((b) => b.toLowerCase() === nameLower)) {
    return { fit: 0, reasons: ['on your blocklist'] };
  }

  const avoid = new Set(options.avoidCategories ?? DEFAULT_AVOID_CATEGORIES);
  if (profile.topics.some((t) => avoid.has(t))) {
    return { fit: 0, reasons: ['avoid-category'] };
  }

  /* topic overlap: does the DRAFT topic set intersect the SUBREDDIT topic set? */
  const draftTopics = inferTopics(draftText);
  const subText = `${profile.name} ${profile.description} ${profile.sidebar}`;
  const subCats = new Set<string>([
    ...inferTopics(subText).categories.map((c) => c.category),
    ...profile.topics,
  ]);
  let overlap = 0;
  const matchedCategories: string[] = [];
  for (const { category, score } of draftTopics.categories) {
    if (!subCats.has(category)) continue;
    const declared = profile.topics.includes(category);
    overlap += 0.5 + Math.min(score, 3) * 0.2 + (declared ? 0.6 : 0);
    matchedCategories.push(category);
  }
  if (draftText.toLowerCase().includes(profile.name.toLowerCase())) overlap += 0.5;
  const topicScore = clamp(overlap / 1.6);
  if (matchedCategories.length > 0) {
    reasons.push(`topic match (${unique(matchedCategories).slice(0, 2).join(', ')})`);
  }

  /* size / activity */
  const activity = profile.activity ?? 0;
  let sizeScore = clamp(activity / 100);
  if ((profile.subscribers ?? 0) > 0 && (profile.subscribers ?? 0) < 3000) {
    // Tiny subs get low reach but high engagement — useful for a first post.
    sizeScore = 0.35;
    reasons.push('small but high-engagement subreddit');
  } else if ((profile.subscribers ?? 0) > 1_000_000) {
    sizeScore = clamp(sizeScore * 0.85);
    reasons.push('very large — hard to break into, high reward');
  } else if (sizeScore > 0.4) {
    reasons.push('healthy size and activity');
  }

  /* history + affinity */
  const inHistory = (options.history ?? []).some((h) => h.toLowerCase() === nameLower);
  const affinity = clamp(options.affinity?.[profile.name] ?? 0);
  let trustScore = affinity;
  if (inHistory) {
    trustScore = clamp(trustScore + 0.35);
    reasons.push('you have commented here before');
  }

  /* rule friendliness */
  let ruleScore = 1;
  if (!profile.allowLinks) {
    ruleScore -= 0.35;
    reasons.push('no links allowed — product goes in comments');
  }
  if (!profile.allowSelfPromo) {
    ruleScore -= 0.4;
    reasons.push('self-promo restricted');
  }
  if (profile.requiresFlair) {
    ruleScore -= 0.05;
    reasons.push('flair required');
  }
  if (profile.quarantined || profile.restricted) ruleScore -= 0.6;
  ruleScore = clamp(ruleScore);

  /* learned style performance */
  const styleBias = clamp((options.styleBias?.[profile.name] ?? 0.5) as number);
  if (styleBias > 0.62) reasons.push(`${options.style ?? 'this style'} has performed well here`);
  else if (styleBias < 0.38) reasons.push(`${options.style ?? 'this style'} has underperformed here`);

  const fit =
    topicScore * 0.4 + sizeScore * 0.2 + trustScore * 0.15 + ruleScore * 0.15 + styleBias * 0.1;

  return { fit: round(clamp(fit) * 100, 1), reasons: unique(reasons) };
}

/** Rank a candidate pool and return the top N as full suggestions. */
export function matchSubreddits(
  profiles: readonly SubredditProfile[],
  draft: ComplianceInput & { style?: string },
  options: MatchOptions = {},
): SubredditSuggestion[] {
  const limit = options.limit ?? 3;
  const draftText = `${draft.title}\n${draft.body}`;

  const suggestions = profiles.map((profile) => {
    const { fit, reasons } = scoreSubreddit(profile, draftText, {
      ...options,
      ...(draft.style ? { style: draft.style } : {}),
    });
    const check = checkCompliance(profile, draft);
    return {
      subreddit: profile.name,
      fit,
      reasons,
      compliance: check.compliance,
      violations: check.violations,
      compliant: check.compliant,
      subscribers: profile.subscribers,
      activity: profile.activity,
      bestHoursUtc: topHours(profile.activityByHourUtc, 3),
    } satisfies SubredditSuggestion;
  });

  return suggestions
    .filter((s) => s.fit > 0)
    .sort((a, b) => {
      // A non-compliant suggestion is still shown, but always below a compliant one.
      if (a.compliant !== b.compliant) return a.compliant ? -1 : 1;
      return b.fit - a.fit;
    })
    .slice(0, limit);
}

/** Top-N hours (UTC) by activity score, with a minimum separation so they spread out. */
export function topHours(activityByHourUtc: readonly number[], count: number): number[] {
  if (activityByHourUtc.length !== 24) return [];
  const scored = activityByHourUtc
    .map((score, hour) => ({ hour, score }))
    .sort((a, b) => b.score - a.score);
  const picked: number[] = [];
  for (const candidate of scored) {
    if (picked.length >= count) break;
    // Separation is circular: 23:00 and 01:00 are two hours apart on the clock.
    const farEnough = picked.every((h) => {
      const gap = Math.abs(h - candidate.hour);
      return Math.min(gap, 24 - gap) >= 3;
    });
    if (farEnough) picked.push(candidate.hour);
  }
  return picked.sort((a, b) => a - b);
}

/** Fallback candidate pool when no live profiles are available (offline demo / CLI). */
export function defaultSubredditPool(): SubredditProfile[] {
  const fixtures: Array<{
    name: string;
    category: string;
    subscribers: number;
    allowLinks: boolean;
    allowSelfPromo: boolean;
    requiresFlair: boolean;
  }> = [
    { name: 'SideProject', category: 'sideproject', subscribers: 42_000, allowLinks: true, allowSelfPromo: true, requiresFlair: false },
    { name: 'webdev', category: 'webdev', subscribers: 900_000, allowLinks: true, allowSelfPromo: false, requiresFlair: false },
    { name: 'programming', category: 'programming', subscribers: 3_200_000, allowLinks: false, allowSelfPromo: false, requiresFlair: true },
    { name: 'ExperiencedDevs', category: 'programming', subscribers: 800_000, allowLinks: true, allowSelfPromo: true, requiresFlair: false },
    { name: 'indiehackers', category: 'indiehackers', subscribers: 45_000, allowLinks: true, allowSelfPromo: true, requiresFlair: false },
    { name: 'SaaS', category: 'indiehackers', subscribers: 28_000, allowLinks: true, allowSelfPromo: true, requiresFlair: false },
    { name: 'selfhosted', category: 'selfhosted', subscribers: 320_000, allowLinks: true, allowSelfPromo: false, requiresFlair: false },
    { name: 'devops', category: 'devops', subscribers: 240_000, allowLinks: true, allowSelfPromo: false, requiresFlair: false },
    { name: 'LocalLLaMA', category: 'ai', subscribers: 900_000, allowLinks: true, allowSelfPromo: true, requiresFlair: false },
    { name: 'datascience', category: 'data', subscribers: 420_000, allowLinks: true, allowSelfPromo: false, requiresFlair: false },
    { name: 'netsec', category: 'security', subscribers: 180_000, allowLinks: false, allowSelfPromo: false, requiresFlair: false },
    { name: 'IBuiltThis', category: 'sideproject', subscribers: 12_000, allowLinks: true, allowSelfPromo: true, requiresFlair: false },
    { name: 'smallbusiness', category: 'indiehackers', subscribers: 90_000, allowLinks: true, allowSelfPromo: false, requiresFlair: false },
  ];

  return fixtures.map((f) => ({
    name: f.name,
    displayName: f.name,
    subscribers: f.subscribers,
    activeUsers: null,
    activity: null,
    upvoteRatio: 0.96,
    postsPerDay: null,
    over18: false,
    restricted: false,
    quarantined: false,
    description: `A community for ${f.category}`,
    sidebar: '',
    rules: [],
    flairs: [],
    activityByHourUtc: [],
    topics: [f.category],
    allowSelfPromo: f.allowSelfPromo,
    allowLinks: f.allowLinks,
    requiresFlair: f.requiresFlair,
    fetchedAt: new Date().toISOString(),
  } satisfies SubredditProfile));
}