import { NextRequest } from 'next/server';
import { RedditClient } from '@upvote/reddit';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { decryptTokens, encryptTokens } from '@/lib/crypto';
import { badRequest, handler, ok, serverError } from '@/lib/api';
import { requireApiUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Reddit OAuth: start the install, then exchange the code.
 * The user's own account is the only account Upvote ever posts from.
 */
export async function GET(request: NextRequest) {
  return handler(async () => {
    const user = await requireApiUser();
    const code = request.nextUrl.searchParams.get('code');
    const state = request.nextUrl.searchParams.get('state');

    if (!code) {
      const client = new RedditClient({
        clientId: process.env.REDDIT_CLIENT_ID ?? '',
        clientSecret: process.env.REDDIT_CLIENT_SECRET ?? '',
        redirectUri: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/auth/reddit/callback`,
      });
      const installState = `upvote:${user.id}`;
      return Response.redirect(client.authorizeUrl(installState));
    }

    // Bind the callback to the user who started the flow. Substring matching
    // would let an attacker prepend text to a valid id, so this is exact.
    if (state !== `upvote:${user.id}`) {
      return badRequest('OAuth state mismatch. Start the connect flow again.');
    }

    const client = new RedditClient({
      clientId: process.env.REDDIT_CLIENT_ID ?? '',
      clientSecret: process.env.REDDIT_CLIENT_SECRET ?? '',
      redirectUri: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/auth/reddit/callback`,
    });

    const tokens = await client.exchangeCode(code);
    client.setTokens(tokens);
    const me = await client.me();

    await db
      .insert(connections)
      .values({
        id: `conn_${user.id}_reddit`,
        userId: user.id,
        provider: 'reddit',
        accessTokenEncrypted: encryptTokens({ accessToken: tokens.accessToken }),
        refreshTokenEncrypted: encryptTokens({ refreshToken: tokens.refreshToken }),
        accountName: me.name,
        scopes: tokens.scope ?? '',
        expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
        accountAgeDays: Math.max(0, Math.floor((Date.now() - me.createdUtc * 1000) / 86_400_000)),
      })
      .onConflictDoUpdate({
        target: connections.userId,
        set: {
          accessTokenEncrypted: encryptTokens({ accessToken: tokens.accessToken }),
          refreshTokenEncrypted: encryptTokens({ refreshToken: tokens.refreshToken }),
          accountName: me.name,
          updatedAt: new Date(),
        },
      });

    const redirect = new URL('/dashboard/settings', request.nextUrl.origin);
    redirect.searchParams.set('connected', 'reddit');
    return Response.redirect(redirect);
  });
}

export async function POST(request: NextRequest) {
  return handler(async () => {
    const user = await requireApiUser();
    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (body.action !== 'disconnect') return badRequest('Unsupported action.');

    await db
      .delete(connections)
      .where(and(eq(connections.userId, user.id), eq(connections.provider, 'reddit')));
    return ok({ disconnected: true });
  });
}
