import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { planById, planForPriceId, type Plan, type PlanId } from '@upvote/core';
import { db } from '@/db';
import { settings, users } from '@/db/schema';
import { handler, ok, serverError } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key, { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion });
}

/**
 * Stripe webhook.
 *
 * Signature verification is mandatory and happens against the raw body. Plan
 * changes are the only thing this endpoint writes; everything else is logged.
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const signature = request.headers.get('stripe-signature');
    if (!secret || !signature) return serverError('Stripe webhook is not configured.');

    const raw = await request.text();
    let event: Stripe.Event;
    try {
      event = stripe().webhooks.constructEvent(raw, signature, secret);
    } catch (error) {
      return serverError(`Invalid Stripe signature: ${(error as Error).message}`);
    }

    const client = stripe();
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const clerkId = session.client_reference_id ?? session.metadata?.clerkId;
        const priceId = session.metadata?.priceId;
        if (clerkId && priceId) await applyPlan(clerkId, priceId);
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const clerkId = subscription.metadata?.clerkId;
        const priceId = subscription.items.data[0]?.price?.id;
        if (clerkId && priceId) {
          // A cancelled subscription drops the founder to free rather than
          // leaving them on Pro features they stopped paying for.
          const plan: Plan | undefined =
          event.type === 'customer.subscription.deleted' ? undefined : planForPriceId(priceId);
          await applyPlan(clerkId, plan?.id ?? 'free');
        }
        break;
      }
      default:
        break;
    }

    void client;
    return ok({ received: true, type: event.type });
  });
}

async function applyPlan(clerkId: string, planId: string) {
  const [user] = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
  if (!user) return;
  const plan = planById(planId as PlanId);
  await db.update(users).set({ plan: plan.id }).where(eq(users.id, user.id));
  await db
    .update(settings)
    .set({ updatedAt: new Date() })
    .where(eq(settings.userId, user.id));
}