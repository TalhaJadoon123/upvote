import { desc, eq } from 'drizzle-orm';
import { OnboardingWizard, type OnboardingDraft } from '@/components/onboarding-wizard';
import { connections, drafts } from '@/db/schema';
import { db } from '@/db';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const user = await requireUser();

  const linked = await db
    .select()
    .from(connections)
    .where(eq(connections.userId, user.id))
    .limit(10);

  const recent = await db
    .select()
    .from(drafts)
    .where(eq(drafts.userId, user.id))
    .orderBy(desc(drafts.createdAt))
    .limit(5);

  const preview: OnboardingDraft[] = recent.map((row) => {
    const suggestions = row.suggestedSubreddits as Array<{ subreddit: string; fit: number; violations: string[] }>;
    return {
      id: row.id,
      style: row.style,
      title: row.title,
      body: row.body,
      firstComment: row.firstComment,
      subreddit: row.primarySubreddit ?? suggestions[0]?.subreddit ?? null,
      fit: suggestions[0]?.fit ?? 0,
      score: row.authenticityScore,
      breakdown: row.authenticityBreakdown,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      violations: suggestions[0]?.violations ?? [],
    };
  });

  return (
    <div className="mx-auto max-w-4xl px-5 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Set up Upvote</h1>
      <p className="mb-8 mt-1 text-sm text-muted-foreground">
        Three steps. The last one is the one that matters: seeing five finished drafts before you pay for
        anything.
      </p>
      <OnboardingWizard
        step={preview.length > 0 ? 2 : 0}
        draftPreview={preview}
        connected={{
          github: false,
          reddit: linked.some((c) => c.provider === 'reddit'),
        }}
      />
    </div>
  );
}