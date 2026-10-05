import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { parsePaddleEvent, verifyPaddleSignature, type PlanId } from '@upvote/core';
import { db } from '@/db';
import { users } from '@/db/schema';
import { badRequest, handler, ok, serverError } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Paddle webhook.
 *
 * Paddle's signature includes a timestamp specifically so a captured request
 * cannot be replayed later; `verifyPaddleSignature` rejects anything outside the
 * tolerance window, and that check is part of accepting the event.
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    if (!secret) return serverError('Paddle webhook is not configured.');

    const raw = await request.text();
    if (!verifyPaddleSignature(raw, request.headers.get('paddle-signature'), secret)) {
      return badRequest('Invalid or replayed signature.');
    }

    const parsed = parsePaddleEvent(raw);
    if (!parsed.ok || !parsed.event) return badRequest(parsed.error ?? 'Unparseable event.');
    const event = parsed.event;

    if (!event.clerkId) {
      return ok({ applied: false, reason: 'no clerkId in custom_data' });
    }

    const [user] = await db.select().from(users).where(eq(users.clerkId, event.clerkId)).limit(1);
    if (!user) return ok({ applied: false, reason: 'no user for that clerkId' });

    if (user.plan !== event.plan) {
      await db.update(users).set({ plan: event.plan as PlanId }).where(eq(users.id, user.id));
    }

    return ok({ applied: true, plan: event.plan, type: event.type });
  });
}

export async function GET() {
  return ok({ service: 'paddle-webhook' });
}