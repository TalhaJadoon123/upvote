/**
 * Plan definitions and entitlements.
 * Single source of truth for the CLI, the dashboard and the billing webhooks.
 */
import { z } from 'zod';

export const PlanIdSchema = z.enum(['free', 'pro', 'team']);
export type PlanId = z.infer<typeof PlanIdSchema>;

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in cents. */
  priceCents: number;
  tagline: string;
  features: string[];
  limits: {
    draftsPerMonth: number | 'unlimited';
    scheduledPostsPerMonth: number | 'unlimited';
    trackedSubreddits: number | 'unlimited';
    seats: number;
    autoPost: boolean;
    analyticsHistoryDays: number;
  };
  /** Price id to use with Stripe / LemonSqueezy / Paddle. */
  providerPriceIds: { stripe?: string; lemonSqueezy?: string; paddle?: string };
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    priceCents: 0,
    tagline: 'See whether this sounds like you.',
    features: [
      '3 drafts per month',
      '1 tracked repository',
      'Voice profile (50 samples)',
      'Manual export only — nothing posts automatically',
    ],
    limits: {
      draftsPerMonth: 3,
      scheduledPostsPerMonth: 0,
      trackedSubreddits: 3,
      seats: 1,
      autoPost: false,
      analyticsHistoryDays: 7,
    },
    providerPriceIds: {},
  },
  {
    id: 'pro',
    name: 'Pro',
    priceCents: 1900,
    tagline: 'Ship code. We\'ll write the post.',
    features: [
      'Unlimited drafts',
      'Auto-scheduling at each subreddit\'s best hour',
      'Subreddit rules auto-compliance',
      'Post → signup → revenue attribution',
      'Comment reply suggestions',
      'Full analytics + learning loop',
      'Post with your own Reddit account (we never use ours)',
    ],
    limits: {
      draftsPerMonth: 'unlimited',
      scheduledPostsPerMonth: 'unlimited',
      trackedSubreddits: 'unlimited',
      seats: 1,
      autoPost: true,
      analyticsHistoryDays: 730,
    },
    providerPriceIds: {
      stripe: 'price_upvote_pro_monthly',
      lemonSqueezy: 'lemon_upvote_pro',
      paddle: 'pdl_upvote_pro_monthly',
    },
  },
  {
    id: 'team',
    name: 'Team',
    priceCents: 4900,
    tagline: 'For small teams shipping in public.',
    features: [
      'Everything in Pro',
      '5 seats',
      'Multiple Reddit + GitHub accounts',
      'Shared voice library',
      'Approval queue for a marketing lead',
      'Slack digest + webhook digests',
    ],
    limits: {
      draftsPerMonth: 'unlimited',
      scheduledPostsPerMonth: 'unlimited',
      trackedSubreddits: 'unlimited',
      seats: 5,
      autoPost: true,
      analyticsHistoryDays: 1095,
    },
    providerPriceIds: {
      stripe: 'price_upvote_team_monthly',
      lemonSqueezy: 'lemon_upvote_team',
      paddle: 'pdl_upvote_team_monthly',
    },
  },
];

export function planById(id: PlanId): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0]!;
}

export function planForPriceId(priceId: string): Plan | undefined {
  return PLANS.find((p) => Object.values(p.providerPriceIds).includes(priceId));
}

export interface EntitlementCheck {
  allowed: boolean;
  reason?: string;
  used: number;
  limit: number | 'unlimited';
}

/** Gate a metered action against the plan. */
export function checkEntitlement(
  plan: Plan,
  action: 'draft' | 'schedule' | 'subreddit' | 'seat' | 'autopost' | 'analytics',
  currentUsage: number,
): EntitlementCheck {
  const limitFor = (): number | 'unlimited' => {
    switch (action) {
      case 'draft':
        return plan.limits.draftsPerMonth;
      case 'schedule':
        return plan.limits.scheduledPostsPerMonth;
      case 'subreddit':
        return plan.limits.trackedSubreddits;
      case 'seat':
        return plan.limits.seats;
      case 'analytics':
        return plan.limits.analyticsHistoryDays;
      case 'autopost':
        return plan.limits.autoPost ? 'unlimited' : 0;
    }
  };
  const limit = limitFor();
  if (limit === 'unlimited') return { allowed: true, used: currentUsage, limit };
  if (currentUsage >= limit) {
    return {
      allowed: false,
      reason: `${plan.name} plan allows ${limit} ${action === 'autopost' ? 'auto-post' : action}${
        action === 'analytics' ? ' days of analytics' : ''
      }. Upgrade to keep going.`,
      used: currentUsage,
      limit,
    };
  }
  return { allowed: true, used: currentUsage, limit };
}

/** Public pricing shape for the landing page. */
export function pricingTable(): Array<{
  id: PlanId;
  name: string;
  price: string;
  tagline: string;
  features: string[];
  cta: string;
  highlighted: boolean;
}> {
  return PLANS.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.priceCents === 0 ? '$0' : `$${Math.round(p.priceCents / 100)}`,
    tagline: p.tagline,
    features: p.features,
    cta: p.id === 'free' ? 'Start free' : p.id === 'pro' ? 'Start 7-day trial' : 'Talk to us',
    highlighted: p.id === 'pro',
  }));
}