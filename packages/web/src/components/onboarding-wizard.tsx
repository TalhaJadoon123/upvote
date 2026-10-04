'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { VoiceScore } from '@/components/voice-score';

export interface OnboardingDraft {
  id: string;
  style: string;
  title: string;
  body: string;
  firstComment: string;
  subreddit: string | null;
  fit: number;
  score: number;
  breakdown: Record<string, number>;
  scheduledFor: string | null;
  violations: string[];
}

const STEPS = ['Connect', 'Voice', 'Drafts'] as const;

/**
 * Onboarding.
 *
 * The whole flow is one screen and one input: paste what you shipped. We show
 * real drafts immediately, because "trust me" is a bad first impression and a
 * finished post is a good one.
 */
export function OnboardingWizard({
  step,
  draftPreview,
  connected,
}: {
  step: number;
  draftPreview: OnboardingDraft[];
  connected: { github: boolean; reddit: boolean };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [moment, setMoment] = useState(
    'shipped a rewrite of the ingest layer. the retry loop no longer caches its own failures. lesson: when the smart optimization keeps firing, it is usually the bug.',
  );
  const [samples, setSamples] = useState('');

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <ol className="flex items-center gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={
              i === step
                ? 'rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground'
                : i < step
                  ? 'rounded-full border px-3 py-1 text-muted-foreground'
                  : 'rounded-full border px-3 py-1 text-muted-foreground/60'
            }
          >
            {label}
          </li>
        ))}
      </ol>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Connect your accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            GitHub tells Upvote what you shipped. Reddit is where the drafts get published — with your own
            account, never a shared one.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href="https://github.com/settings/connections/new"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              {connected.github ? 'GitHub connected' : 'Connect GitHub'}
            </a>
            <a
              href="/api/auth/reddit"
              className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              {connected.reddit ? 'Reddit connected' : 'Connect Reddit'}
            </a>
          </div>
          <p className="text-xs text-muted-foreground">
            You can skip Reddit for now and still generate drafts — you just cannot publish them yet.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Teach it your voice</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            If you are connected to Reddit we read your past posts and comments. Otherwise paste three or
            four things you have written — any platform. Separate them with a blank line.
          </p>
          <Textarea
            value={samples}
            onChange={(e) => setSamples(e.target.value)}
            placeholder="Paste a few of your posts, comments, tweets, README, commit messages..."
            className="min-h-[140px]"
          />
          <p className="text-xs text-muted-foreground">
            {samples.trim().split(/\n\s*\n/).filter((s) => s.trim().length > 40).length} samples detected
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. Ship something</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Describe the last thing you shipped in your own words. Five drafts come back, each scored
            against your voice.
          </p>
          <Textarea value={moment} onChange={(e) => setMoment(e.target.value)} className="min-h-[100px]" />
          <Button
            disabled={pending || moment.trim().length < 20}
            onClick={() =>
              startTransition(async () => {
                const response = await fetch('/api/onboarding/generate', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ moment, samples }),
                });
                if (response.ok) router.refresh();
              })
            }
          >
            {pending ? 'Writing...' : 'Generate my five drafts'}
          </Button>
        </CardContent>
      </Card>

      {draftPreview.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Your drafts</h2>
          {draftPreview.map((draft) => (
            <Card key={draft.id}>
              <CardContent className="space-y-3 p-5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full border px-2 py-0.5">{draft.style.replace(/_/g, ' ')}</span>
                  {draft.subreddit && <span className="rounded-full border px-2 py-0.5">r/{draft.subreddit}</span>}
                  {draft.scheduledFor && (
                    <span className="rounded-full border px-2 py-0.5">
                      best time {new Date(draft.scheduledFor).toUTCString().slice(0, 22)}
                    </span>
                  )}
                </div>
                <h3 className="font-semibold">{draft.title}</h3>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{draft.body}</p>
                {draft.violations.length > 0 && (
                  <p className="text-xs text-amber-700">{draft.violations.join(' ')}</p>
                )}
                <VoiceScore score={draft.score} breakdown={draft.breakdown} />
              </CardContent>
            </Card>
          ))}
          <Button onClick={() => router.push('/dashboard')}>Open the dashboard</Button>
        </div>
      )}
    </div>
  );
}