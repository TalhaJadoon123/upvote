import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getScheduledForCalendar } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Month view of the queue.
 *
 * The point of this screen is restraint: a founder who posts three times a week
 * for a year should never be tempted to post four times in a day. The calendar
 * shows the guardrail load, not just the drafts.
 */
export default async function CalendarPage() {
  const rows = await getScheduledForCalendar(30);
  const now = new Date();

  const days = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(now.getTime() + i * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    return {
      key,
      date,
      items: rows.filter((r) => r.scheduledFor?.toISOString().slice(0, 10) === key),
    };
  });

  const scheduledCount = rows.filter((r) => r.status === 'scheduled').length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
        <p className="text-sm text-muted-foreground">
          {scheduledCount} scheduled in the next 30 days. Times are shown in your local zone.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {days.map(({ key, date, items }) => {
          const blocked = items.length >= 3;
          return (
            <div
              key={key}
              className={
                blocked
                  ? 'rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/20'
                  : 'rounded-lg border bg-card p-3'
              }
            >
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium">
                  {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                {blocked && <span className="text-[10px] text-amber-700">at cap</span>}
              </div>
              <div className="mt-2 space-y-1">
                {items.length === 0 ? (
                  <span className="text-xs text-muted-foreground">&mdash;</span>
                ) : (
                  items.map((item) => (
                    <div key={item.id} className="rounded bg-accent px-2 py-1 text-[11px] leading-tight">
                      <div className="font-mono tabular-nums">
                        {item.scheduledFor?.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div className="truncate text-muted-foreground">
                        r/{item.primarySubreddit ?? '?'}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How Upvote picks the hour</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Each subreddit gets a predicted peak from its own activity curve, blended with the results of
            your own posts once you have history. New accounts start on the general Reddit curve: mornings
            around 9-11 UTC and evenings around 18-21 UTC.
          </p>
          <p>
            Posts are never scheduled in the same subreddit twice in a week, and never more than three in a
            day. If a post gets removed, that subreddit is on cooldown for 72 hours.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">max 3 / day</Badge>
        <Badge variant="outline">max 1 / subreddit / week</Badge>
        <Badge variant="outline">72h cooldown after removal</Badge>
        <Badge variant="outline">manual approval by default</Badge>
      </div>
    </div>
  );
}