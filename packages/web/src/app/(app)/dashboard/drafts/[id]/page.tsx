import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DraftEditor } from '@/components/draft-editor';
import { getDashboardData, getDraft } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getDraft(id);
  if (!result) notFound();

  const { guardrails } = await getDashboardData();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          Back to drafts
        </Link>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {result.draft.style.replace(/_/g, ' ')}
        </span>
      </div>

      <DraftEditor
        threshold={Number(guardrails?.minAuthenticityScore ?? 85)}
        draft={{
          id: result.draft.id,
          title: result.draft.title,
          titleVariants: result.draft.titleVariants,
          body: result.draft.body,
          firstComment: result.draft.firstComment,
          flair: result.draft.flair,
          status: result.draft.status,
          style: result.draft.style,
          authenticityScore: result.draft.authenticityScore,
          authenticityBreakdown: result.draft.authenticityBreakdown,
          authenticityNotes: result.draft.authenticityNotes,
          primarySubreddit: result.draft.primarySubreddit,
          suggestedSubreddits: result.draft.suggestedSubreddits as never,
          scheduledFor: result.draft.scheduledFor?.toISOString() ?? null,
          permalink: result.draft.permalink,
        }}
      />
    </div>
  );
}