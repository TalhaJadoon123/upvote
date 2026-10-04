import { NextRequest } from 'next/server';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/db';
import { drafts, users } from '@/db/schema';
import { handler, ok, serverError } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Daily digest: "3 shipping moments today. 3 drafts ready."
 *
 * Sent by Resend when a key is configured; otherwise the payload is returned so
 * a queue or a CLI job can deliver it. Never fails the cron run over email.
 */
export async function POST(request: NextRequest) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    const provided = request.headers.get('x-cron-secret') ?? request.nextUrl.searchParams.get('secret');
    if (!secret || provided !== secret) return serverError('Unauthorized cron call.');

    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const accounts = await db.select().from(users).where(eq(users.plan, 'pro'));

    const sent: Array<{ userId: string; drafts: number }> = [];
    for (const user of accounts) {
      const todays = await db
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.userId, user.id),
            gte(drafts.createdAt, since),
            lte(drafts.createdAt, now),
          ),
        )
        .orderBy(desc(drafts.createdAt))
        .limit(25);

      if (todays.length === 0) continue;

      const best = todays.reduce((a, b) => (b.authenticityScore > a.authenticityScore ? b : a));
      const subject = `${todays.length} draft${todays.length === 1 ? '' : 's'} ready · best voice ${best.authenticityScore.toFixed(0)}`;
      const text = [
        `${todays.length} shipping moment${todays.length === 1 ? '' : 's'} turned into drafts.`,
        '',
        ...todays.map(
          (d) => `- [${d.authenticityScore.toFixed(0)}] ${d.title} → r/${d.primarySubreddit ?? 'unmatched'}`,
        ),
        '',
        'Review: ' + `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/dashboard`,
      ].join('\n');

      const delivered = await sendEmail({ to: user.email, subject, text });
      sent.push({ userId: user.id, drafts: todays.length, ...(delivered ? {} : { skipped: true }) });
    }

    return ok({ processed: accounts.length, sent });
  });
}

async function sendEmail(input: { to: string; subject: string; text: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM_EMAIL;
  if (!apiKey || !from) return false;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: input.to, subject: input.subject, text: input.text }),
    });
    return response.ok;
  } catch {
    return false;
  }
}