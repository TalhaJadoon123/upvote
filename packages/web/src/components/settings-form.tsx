'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { updateSettings, updateVoiceSettings, addWatchedRepo } from '@/app/(app)/dashboard/actions';

/**
 * Settings.
 *
 * Defaults are conservative on purpose. Every loosening of a guardrail is one
 * line of copy explaining what it costs, because the day a founder gets
 * shadowbanned is the day they stop paying.
 */
export function SettingsForm({
  initial,
  productUrl,
  plan,
  connections,
  watchedRepos,
}: {
  initial: {
    maxPostsPerDay: number;
    maxPostsPerSubredditPerWeek: number;
    minAuthenticityScore: number;
    requireManualApproval: boolean;
    requirePriorEngagement: boolean;
    cooldownHoursAfterRemoval: number;
    blocklist: string[];
  };
  productUrl: string | null;
  plan: string;
  connections: Array<{ provider: string; accountName: string | null }>;
  watchedRepos: Array<{ id: string; owner: string; repo: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [maxPerDay, setMaxPerDay] = useState(initial.maxPostsPerDay);
  const [maxPerSub, setMaxPerSub] = useState(initial.maxPostsPerSubredditPerWeek);
  const [minVoice, setMinVoice] = useState(initial.minAuthenticityScore);
  const [approval, setApproval] = useState(initial.requireManualApproval);
  const [priorEngagement, setPriorEngagement] = useState(initial.requirePriorEngagement);
  const [cooldown, setCooldown] = useState(initial.cooldownHoursAfterRemoval);
  const [blocklist, setBlocklist] = useState(initial.blocklist.join(', '));
  const [formality, setFormality] = useState(0.5);
  const [humor, setHumor] = useState(0.3);
  const [repo, setRepo] = useState('');

  const save = () =>
    startTransition(async () => {
      await updateSettings({
        maxPostsPerDay: maxPerDay,
        maxPostsPerSubredditPerWeek: maxPerSub,
        minAuthenticityScore: minVoice,
        requireManualApproval: approval,
        requirePriorEngagement: priorEngagement,
        cooldownHoursAfterRemoval: cooldown,
        blocklist: blocklist
          .split(',')
          .map((s) => s.trim().replace(/^\/?r\//, ''))
          .filter(Boolean),
      });
      await updateVoiceSettings({ formality, humor });
      router.refresh();
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
          ) : (
            connections.map((connection) => (
              <div key={connection.provider} className="flex items-center justify-between text-sm">
                <span className="capitalize">{connection.provider}</span>
                <Badge variant="success">{connection.accountName ?? 'connected'}</Badge>
              </div>
            ))
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            <a
              href="/api/auth/reddit"
              className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              {connections.some((c) => c.provider === 'reddit') ? 'Reconnect Reddit' : 'Connect Reddit'}
            </a>
            <a
              href="https://github.com/settings/connections/new"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              Connect GitHub
            </a>
          </div>
          <p className="pt-1 text-xs text-muted-foreground">
            Posts are published from your own Reddit account. Upvote never posts from a shared account.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Product</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="product">
            Product URL
          </label>
          <Input id="product" defaultValue={productUrl ?? ''} placeholder="https://yourproduct.com" />
          <p className="text-xs text-muted-foreground">
            Upvote appends UTM parameters so every signup and dollar is attributed to the post that produced it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Watched repositories</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {watchedRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repositories watched.</p>
          ) : (
            watchedRepos.map((watched) => (
              <div key={watched.id} className="text-sm">
                {watched.owner}/{watched.repo}
              </div>
            ))
          )}
          <div className="flex gap-2">
            <Input
              value={repo}
              placeholder="owner/repo"
              onChange={(e) => setRepo(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() =>
                startTransition(async () => {
                  const [owner, name] = repo.split('/');
                  if (owner && name) await addWatchedRepo(owner.trim(), name.trim());
                  setRepo('');
                  router.refresh();
                })
              }
            >
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Guardrails</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row label="Max posts per day" hint="Three a day is the ceiling most subreddits tolerate.">
            <Input
              type="number"
              min={1}
              max={10}
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(Number(e.target.value))}
              className="w-20"
            />
          </Row>
          <Row label="Max posts per subreddit per week" hint="The single most effective anti-downvote rule.">
            <Input
              type="number"
              min={1}
              max={7}
              value={maxPerSub}
              onChange={(e) => setMaxPerSub(Number(e.target.value))}
              className="w-20"
            />
          </Row>
          <Row label="Minimum voice score" hint="Drafts below this are regenerated rather than queued.">
            <Input
              type="number"
              min={0}
              max={100}
              value={minVoice}
              onChange={(e) => setMinVoice(Number(e.target.value))}
              className="w-20"
            />
          </Row>
          <Row label="Cooldown after a removal (hours)" hint="Reddit removes first posts from new accounts often.">
            <Input
              type="number"
              min={0}
              max={720}
              value={cooldown}
              onChange={(e) => setCooldown(Number(e.target.value))}
              className="w-24"
            />
          </Row>
          <Row label="Never post in" hint="Comma-separated subreddit names.">
            <Input value={blocklist} onChange={(e) => setBlocklist(e.target.value)} placeholder="netsec, AskReddit" />
          </Row>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
            Require my approval before anything posts
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={priorEngagement}
              onChange={(e) => setPriorEngagement(e.target.checked)}
            />
            Only post where I have commented before
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Voice targets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row label="Formality" hint="0 is raw and casual, 1 is formal and measured.">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={formality}
              onChange={(e) => setFormality(Number(e.target.value))}
            />
          </Row>
          <Row label="Humor" hint="How often the drafts should be funny rather than earnest.">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={humor}
              onChange={(e) => setHumor(Number(e.target.value))}
            />
          </Row>
          <Button onClick={save} disabled={pending}>
            {pending ? 'Saving...' : 'Save settings'}
          </Button>
          <p className="text-xs text-muted-foreground">Current plan: {plan}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      {children}
    </div>
  );
}