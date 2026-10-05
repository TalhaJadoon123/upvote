import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { planById, type PlanId } from '@upvote/core';

/**
 * Merchant-of-record billing webhooks: Lemon Squeezy and Paddle.
 *
 * Both send an HMAC signature over the raw body in a header. Verifying it is
 * the only thing standing between a public endpoint and someone granting
 * themselves the Team plan, so both handlers verify first and parse second.
 *
 * Plans are resolved by price/variant id, and an unknown id resolves to free
 * rather than throwing: an unrecognised price must never grant paid features.
 */

export interface BillingEvent {
  provider: 'lemon_squeezy' | 'paddle';
  type: string;
  /** Plan the subscription is now on. */
  plan: PlanId;
  customerId: string | null;
  subscriptionId: string | null;
  /** Clerk user id, taken from provider metadata. */
  clerkId: string | null;
  eventTime: string | null;
}

export interface VerifiedEvent {
  ok: boolean;
  error?: string;
  event?: BillingEvent;
}

/* ------------------------------------------------------------------ */
/* Signature verification                                              */
/* ------------------------------------------------------------------ */

/** Constant-time hex comparison. */
function safeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Lemon Squeezy signs with HMAC-SHA256 over the raw body, hex-encoded, in
 * `X-Signature`.
 */
export function verifyLemonSqueezySignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeHexEqual(expected, signature);
}

const PaddleHeaderSchema = z.object({
  ts: z.string(),
  h1: z.string(),
});

/**
 * Paddle signs with HMAC-SHA256 over `ts:<timestamp>;body:<rawBody>`, base64,
 * in the `Paddle-Signature` header (format: `ts=...;h1=...`).
 */
export function verifyPaddleSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string | undefined,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): boolean {
  if (!header || !secret) return false;

  const parsed = PaddleHeaderSchema.safeParse(parsePaddleHeader(header));
  if (!parsed.success) return false;

  const { ts, h1 } = parsed.data;
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ? options.now() : Date.now();
  const timestamp = Number(ts) * 1000;
  // Reject replays of a signature outside the tolerance window.
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > tolerance * 1000) return false;

  const expected = createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`, 'utf8')
    .digest('base64');
  return safeStringEqual(expected, h1);
}

/** Constant-time comparison of two ASCII strings. */
function safeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Paddle sends `ts=...;h1=...` in a single header. */
function parsePaddleHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key) out[key.trim()] = rest.join('=').trim();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Lemon Squeezy                                                       */
/* ------------------------------------------------------------------ */

const LemonPayloadSchema = z.object({
  meta: z
    .object({
      event_name: z.string().optional(),
      custom_data: z
        .object({ clerkId: z.string().optional(), clerk_id: z.string().optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  data: z
    .object({
      id: z.string().optional(),
      attributes: z
        .object({
          status: z.string().optional(),
          variant_id: z.union([z.string(), z.number()]).optional(),
          user_email: z.string().optional(),
          renews_at: z.string().nullable().optional(),
          ends_at: z.string().nullable().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

/** Map a Lemon Squeezy variant id to a plan, per the price table in core. */
export function planFromLemonVariant(variantId: string | number | undefined): PlanId {
  const id = String(variantId ?? '');
  for (const plan of ['pro', 'team'] as const) {
    const expected = planById(plan).providerPriceIds.lemonSqueezy;
    if (expected && id === expected) return plan;
  }
  return 'free';
}

export function parseLemonSqueezyEvent(rawBody: string): VerifiedEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: 'Body is not valid JSON.' };
  }
  const parsed = LemonPayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: 'Unexpected Lemon Squeezy payload shape.' };

  const meta = parsed.data.meta;
  const attrs = parsed.data.data?.attributes;
  const type = meta?.event_name ?? 'unknown';
  const variantId = attrs?.variant_id;

  // A cancelled or expired subscription drops the founder to free rather than
  // leaving them on paid features they stopped paying for.
  const cancelled = /subscription_cancelled|subscription_expired/i.test(type);
  const status = (attrs?.status ?? '').toLowerCase();
  const ended = status === 'expired' || status === 'cancelled';

  return {
    ok: true,
    event: {
      provider: 'lemon_squeezy',
      type,
      plan: cancelled || ended ? 'free' : planFromLemonVariant(variantId),
      customerId: attrs?.user_email ?? null,
      subscriptionId: parsed.data.data?.id ?? null,
      clerkId: meta?.custom_data?.clerkId ?? meta?.custom_data?.clerk_id ?? null,
      eventTime: attrs?.renews_at ?? attrs?.ends_at ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Paddle                                                              */
/* ------------------------------------------------------------------ */

const PaddlePayloadSchema = z.object({
  event_id: z.string().optional(),
  occurred_at: z.string().optional(),
  data: z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      custom_data: z
        .object({ clerkId: z.string().optional() })
        .passthrough()
        .optional(),
      items: z
        .array(
          z.object({
            price: z
              .object({ id: z.string().optional(), custom_data: z.record(z.string(), z.string()).optional() })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        )
        .optional(),
    })
    .passthrough()
    .optional(),
});

/**
 * Resolve a Paddle price to a plan.
 *
 * Falls back to `upvote_plan` in the price's custom data, which is how a
 * merchant keeps a single price id across renamed products.
 */
export function planFromPaddlePrice(
  priceId: string | undefined,
  planHint?: string,
): PlanId {
  const id = String(priceId ?? '');
  for (const plan of ['pro', 'team'] as const) {
    const expected = planById(plan).providerPriceIds.paddle;
    if (expected && id === expected) return plan;
  }
  const hint = String(planHint ?? '').toLowerCase();
  if (hint === 'pro' || hint === 'team') return hint;
  return 'free';
}

export function parsePaddleEvent(rawBody: string): VerifiedEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: 'Body is not valid JSON.' };
  }
  const parsed = PaddlePayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: 'Unexpected Paddle payload shape.' };

  const data = parsed.data.data;
  const priceId = data?.items?.[0]?.price?.id;
  const planHint = data?.items?.[0]?.price?.custom_data?.upvote_plan;
  const type = String(
    (payload as { event_type?: string }).event_type ?? 'transaction.updated',
  );
  const cancelled = /subscription.cancelled|subscription.paused/i.test(type);
  const status = (data?.status ?? '').toLowerCase();
  const ended = status === 'cancelled' || status === 'paused';

  return {
    ok: true,
    event: {
      provider: 'paddle',
      type,
      plan: cancelled || ended ? 'free' : planFromPaddlePrice(priceId, planHint as string | undefined),
      customerId: null,
      subscriptionId: data?.id ?? null,
      clerkId: data?.custom_data?.clerkId ?? null,
      eventTime: parsed.data.occurred_at ?? null,
    },
  };
}