import { asc, eq } from 'drizzle-orm';
import { connections, settings, watchedRepos } from '@/db/schema';
import { db } from '@/db';
import { getDashboardData } from '../actions';
import { SettingsForm } from '@/components/settings-form';
import { guardrailsFromRow } from '@/lib/guardrails';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { user } = await getDashboardData();
  const userId = user.id;

  const [settingsRow] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);

  const [linked, repos] = await Promise.all([
    db.select().from(connections).where(eq(connections.userId, userId)),
    db.select().from(watchedRepos).where(eq(watchedRepos.userId, userId)).orderBy(asc(watchedRepos.createdAt)),
  ]);

  const defaults = guardrailsFromRow(
    settingsRow ?? {
      maxPostsPerDay: 3,
      maxPostsPerSubredditPerWeek: 1,
      cooldownHoursAfterRemoval: 72,
      blocklist: [],
      requireManualApproval: true,
      requirePriorEngagement: true,
      minAuthenticityScore: 85,
    },
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Guardrails protect the account you spent years building. Loosen them only deliberately.
        </p>
      </div>

      <SettingsForm
        plan={user.plan}
        productUrl={user.productUrl}
        initial={{
          maxPostsPerDay: defaults.maxPostsPerDay,
          maxPostsPerSubredditPerWeek: defaults.maxPostsPerSubredditPerWeek,
          minAuthenticityScore: defaults.minAuthenticityScore,
          requireManualApproval: defaults.requireManualApproval,
          requirePriorEngagement: defaults.requirePriorEngagement,
          cooldownHoursAfterRemoval: defaults.cooldownHoursAfterRemoval,
          blocklist: defaults.blocklist,
        }}
        connections={linked.map((c) => ({ provider: c.provider, accountName: c.accountName }))}
        watchedRepos={repos.map((r) => ({ id: r.id, owner: r.owner, repo: r.repo }))}
      />
    </div>
  );
}