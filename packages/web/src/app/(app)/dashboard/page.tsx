import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getDashboardData } from './actions';

export const dynamic = 'force-dynamic';

export default async function DraftsPage() {
  const { drafts, counts, profile, user } = await getDashboardData();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Drafts</h1>
          <p className="text-sm text-muted-foreground">
            {counts.review} awaiting review · {counts.scheduled} scheduled · {counts.posted} published
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/onboarding"
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Generate drafts
          </Link>
        </div>
      </div>

      {!profile && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/30">
          <CardHeader>
            <CardTitle>No voice profile yet</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            Upvote needs your past writing before it can draft anything that sounds like you.{' '}
            <Link href="/dashboard/voice" className="underline">
              Train your voice
            </Link>{' '}
            — it takes about a minute.
          </CardContent>
        </Card>
      )}

      {drafts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No drafts yet. Connect GitHub and Upvote will turn your next release into five drafts.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {drafts.map((draft) => (
            <Link
              key={draft.id}
              href={`/dashboard/drafts/${draft.id}`}
              className="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/20"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm tabular-nums text-muted-foreground">
                  {draft.id.slice(-6)}
                </span>
                <Badge variant="outline">{draft.style.replace(/_/g, ' ')}</Badge>
                {draft.primarySubreddit && <Badge variant="outline">r/{draft.primarySubreddit}</Badge>}
                <Badge
                  variant={
                    draft.status === 'posted'
                      ? 'success'
                      : draft.status === 'failed'
                        ? 'danger'
                        : draft.status === 'scheduled'
                          ? 'success'
                          : 'default'
                  }
                >
                  {draft.status}
                </Badge>
                <span className="ml-auto font-mono text-sm tabular-nums text-muted-foreground">
                  {draft.authenticityScore.toFixed(0)}
                </span>
              </div>
              <p className="mt-2 font-medium leading-snug">{draft.title}</p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{draft.body}</p>
            </Link>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Signed in as {user.email}. Nothing posts without your approval.
      </p>
    </div>
  );
}