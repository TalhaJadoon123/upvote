/**
 * Auth helpers.
 *
 * Clerk handles sessions. This module maps a Clerk identity onto an Upvote user
 * row and provides the `requireUser()` guard every server action and route
 * handler calls first.
 */
import { currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users, settings, type User } from '@/db/schema';
import { defaultGuardrails } from './guardrails';

export class UnauthorizedError extends Error {
  constructor(message = 'Sign in to continue.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Get the Clerk identity, or null. */
export async function getClerkUser() {
  return currentUser();
}

/**
 * Resolve (or create) the Upvote user for the current Clerk identity.
 * This is the single entry point for "who is calling".
 */
export async function requireUser(): Promise<User> {
  const clerkUser = await currentUser();
  if (!clerkUser) throw new UnauthorizedError();

  const clerkId = clerkUser.id;
  const [existing] = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
  if (existing) return existing;

  const id = `u_${clerkId.slice(0, 20)}`;
  const email = clerkUser.primaryEmailAddress?.emailAddress ?? `${clerkId}@users.noreply.clerk`;
  const [created] = await db
    .insert(users)
    .values({
      id,
      clerkId,
      email,
      name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || null,
      // Founders connecting GitHub and Reddit are on Pro by default; drop to
      // Free manually if we ever want a hard trial gate here.
      plan: 'pro',
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    await db
      .insert(settings)
      .values({ userId: created.id, ...defaultGuardrails() })
      .onConflictDoNothing();
    return created;
  }

  const [fallback] = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
  if (!fallback) throw new UnauthorizedError('Could not provision an account. Try again.');
  return fallback;
}

/** Same as requireUser but returns null instead of throwing (for pages). */
export async function getOptionalUser(): Promise<User | null> {
  const clerkUser = await currentUser();
  if (!clerkUser) return null;
  const [row] = await db.select().from(users).where(eq(users.clerkId, clerkUser.id)).limit(1);
  return row ?? null;
}

/** Guard for API routes: returns the user or a 401-ready error. */
export async function requireApiUser(): Promise<User> {
  try {
    return await requireUser();
  } catch (error) {
    if (error instanceof UnauthorizedError) throw new UnauthorizedError('Not signed in.');
    throw error;
  }
}