import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import {
  parseLemonSqueezyEvent,
  verifyLemonSqueezySignature,
  type PlanId,
} from '@upvote/core';
import { db } from '@/db';
import { users } from '@/db/schema';
import { badRequest, handler, ok, serverError } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lemon Squeezy webhook.
 *
 * Lemon Squeezy is a merchant of record: it handles sales tax and VAT, which is
 * why it is one of the three supported processors. Signature verification is
 * the whole security boundary here, so it runs before any parsing.
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    if (!secret) return serverError('Lemon Squeezy webhook is not configured.');

    const raw = await request.text();
    if (!verifyLemonSqueezySignature(raw, request.headers.get('x-signature'), secret)) {
      return badRequest('Invalid signature.');
    }

    const parsed = parseLemonSqueezyEvent(raw);
    if (!parsed.ok || !parsed.event) return badRequest(parsed.error ?? 'Unparseable event.');
    const event = parsed.event;

    if (!event.clerkId) {
      // We cannot attribute the subscription to a user, so we record nothing
      // rather than guessing. Lemon will retry; the founder's plan stays as-is.
      return ok({ applied: false, reason: 'no clerkId in event metadata' });
    }

    const [user] = await db.select().from(users).where(eq(users.clerkId, event.clerkId)).limit(1);
    if (!user) return ok({ applied: false, reason: 'no user for that clerkId' });

    if (user.plan !== event.plan) {
      await db.update(users).set({ plan: event.plan as PlanId }).where(eq(users.id, user.id));
    }

    return ok({ applied: true, plan: event.plan, type: event.type });
  });
}

/** Lemon Squeezy pings this to validate the endpoint. */
export async function GET() {
  return ok({ service: 'lemon-squeezy-webhook' });
}