import { and, eq } from 'drizzle-orm';
import type { RedditTokens } from '@upvote/reddit';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { decryptTokens } from './crypto';

/**
 * Load a founder's stored Reddit tokens for server-side calls.
 *
 * Lives outside the route module because Next.js only permits a fixed set of
 * exports from a `route.ts` file (handlers plus route config). Keeping it here
 * also means every caller decrypts identically.
 */
export async function loadRedditConnection(
  userId: string,
): Promise<{ row: typeof connections.$inferSelect; tokens: RedditTokens } | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.provider, 'reddit')))
    .limit(1);
  if (!row) return null;

  const access = decryptTokens<{ accessToken: string }>(row.accessTokenEncrypted);
  const refresh = row.refreshTokenEncrypted
    ? decryptTokens<{ refreshToken: string }>(row.refreshTokenEncrypted)
    : null;

  return {
    row,
    tokens: {
      accessToken: access.accessToken,
      ...(refresh?.refreshToken ? { refreshToken: refresh.refreshToken } : {}),
      obtainedAt: row.updatedAt.toISOString(),
      ...(row.expiresAt
        ? { expiresIn: Math.max(60, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)) }
        : {}),
    },
  };
}