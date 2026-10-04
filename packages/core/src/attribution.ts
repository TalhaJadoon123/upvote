/**
 * UTM + click-id helpers.
 *
 * The link we attach to a post is the only way to connect a Reddit upvote to a
 * signup and a dollar. Every published post therefore gets a deterministic,
 * reverse-resolvable tracking link.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const UTM_SOURCE = 'upvote';
export const UTM_MEDIUM = 'reddit';

export interface TrackingLinkParams {
  /** Product URL, e.g. https://acme.dev */
  baseUrl: string;
  userId: string;
  postId: string;
  subreddit: string;
  style: string;
  /** Optional extra path such as /pricing. */
  path?: string;
}

/**
 * Build the tracked URL. Deterministic so we can dedupe and verify later.
 * Uses both standard UTM params (for GA/Stripe-side analytics) and a compact
 * `upv` id (for our own join table).
 */
export function buildTrackingLink(params: TrackingLinkParams): string {
  const url = new URL(normalizeBase(params.baseUrl));
  if (params.path) {
    for (const segment of params.path.split('/').filter(Boolean)) url.pathname = `${url.pathname.replace(/\/$/, '')}/${segment}`;
  }
  url.searchParams.set('utm_source', UTM_SOURCE);
  url.searchParams.set('utm_medium', UTM_MEDIUM);
  url.searchParams.set('utm_campaign', slug(params.subreddit));
  url.searchParams.set('utm_content', slug(params.style));
  url.searchParams.set('utm_term', hashId(`${params.userId}:${params.postId}`));
  url.searchParams.set('upv', hashId(`${params.userId}:${params.postId}`).slice(0, 10));
  return url.toString();
}

export const AttributionSchema = z.object({
  upv: z.string().min(4),
  userId: z.string(),
  postId: z.string(),
  subreddit: z.string(),
  style: z.string(),
});
export type Attribution = z.infer<typeof AttributionSchema>;

/**
 * Recover attribution from an incoming request's query string.
 * Used by the `/api/track` redirect endpoint.
 */
export function parseAttribution(searchParams: URLSearchParams): Attribution | null {
  const upv = searchParams.get('upv') ?? searchParams.get('utm_term');
  if (!upv) return null;
  const parsed = AttributionSchema.safeParse({
    upv,
    userId: searchParams.get('uid') ?? 'unknown',
    postId: searchParams.get('pid') ?? 'unknown',
    subreddit: searchParams.get('utm_campaign') ?? 'unknown',
    style: searchParams.get('utm_content') ?? 'unknown',
  });
  return parsed.success ? parsed.data : null;
}

/** Stable short id. */
export function hashId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function normalizeBase(baseUrl: string): string {
  const withScheme = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return withScheme.replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ */
/* Click / signup / revenue attribution math                            */
/* ------------------------------------------------------------------ */

export interface ClickEvent {
  postId: string;
  at: string;
  referer?: string;
}

export interface SignupEvent {
  postId: string;
  at: string;
  revenueCents?: number;
}

export interface AttributionSummary {
  postId: string;
  impressions: number;
  clicks: number;
  signups: number;
  revenueCents: number;
  ctr: number;
  /** Clicks → signup conversion. */
  clickToSignup: number;
  /** Revenue per post, in dollars. */
  revenuePerPost: number;
}

export function summarizeAttribution(
  postId: string,
  clicks: readonly ClickEvent[],
  signups: readonly SignupEvent[],
  impressions = 0,
): AttributionSummary {
  const postClicks = clicks.filter((c) => c.postId === postId);
  const postSignups = signups.filter((s) => s.postId === postId);
  const revenueCents = postSignups.reduce((acc, s) => acc + (s.revenueCents ?? 0), 0);
  return {
    postId,
    impressions,
    clicks: postClicks.length,
    signups: postSignups.length,
    revenueCents,
    ctr: impressions > 0 ? round4(postClicks.length / impressions) : 0,
    clickToSignup: postClicks.length > 0 ? round4(postSignups.length / postClicks.length) : 0,
    revenuePerPost: round2(revenueCents / 100),
  };
}

/** Total attributed revenue, in cents, for one post. */
export function attributionRevenue(
  signups: readonly SignupEvent[] | { signups: readonly SignupEvent[] },
  postId: string,
): number {
  const events: readonly SignupEvent[] =
    'signups' in signups ? signups.signups : signups;
  return events.filter((s) => s.postId === postId).reduce((acc, s) => acc + (s.revenueCents ?? 0), 0);
}

/**
 * Attribute a Stripe event to a post via the client's metadata (`upv` / `upv_post`),
 * falling back to the most recent click so a signup that lost its cookie still lands.
 */
export function attributeStripeEvent(
  metadata: Record<string, string | undefined>,
  lastClickByUserId: ReadonlyMap<string, ClickEvent>,
  userId: string,
): string | null {
  const direct = metadata.upv_post ?? metadata.post_id;
  if (direct) return direct;
  const lastClick = lastClickByUserId.get(userId);
  return lastClick?.postId ?? null;
}

/* --- tiny local rounding helpers (kept local to avoid an import cycle) --- */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}