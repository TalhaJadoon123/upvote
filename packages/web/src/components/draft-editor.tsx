'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { VoiceScore } from '@/components/voice-score';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea, Input } from '@/components/ui/input';
import { approveDraft, rejectDraft, rescoreDraft, saveDraftEdit } from '@/app/(app)/dashboard/actions';
import type { AuthenticityReport } from '@upvote/core';

/**
 * The review screen.
 *
 * Two rules shape this UI:
 *  1. The voice score updates live while typing, debounced, on the server - never
 *     guessed in the browser.
 *  2. Nothing is destructive. Approve schedules; it never posts unless the
 *     founder explicitly asks.
 */
export function DraftEditor({
  draft: initial,
  threshold = 85,
}: {
  draft: {
    id: string;
    title: string;
    titleVariants: string[];
    body: string;
    firstComment: string;
    flair: string;
    status: string;
    style: string;
    authenticityScore: number;
    authenticityBreakdown: Record<string, number>;
    authenticityNotes: string[];
    primarySubreddit: string | null;
    suggestedSubreddits: Array<{
      subreddit: string;
      fit: number;
      compliant: boolean;
      reasons: string[];
      violations: string[];
      compliance: string[];
    }>;
    scheduledFor: string | null;
    permalink: string | null;
  };
  threshold?: number;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [firstComment, setFirstComment] = useState(initial.firstComment);
  const [flair, setFlair] = useState(initial.flair);
  const [subreddit, setSubreddit] = useState(initial.primarySubreddit ?? '');
  const [report, setReport] = useState<AuthenticityReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<number | null>(null);

  const suggestions = useMemo(
    () => initial.suggestedSubreddits.filter((s) => !s.violations.length),
    [initial.suggestedSubreddits],
  );

  /** Debounced server-side rescore. */
  const scheduleRescore = useCallback(
    (nextTitle: string, nextBody: string) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        startTransition(async () => {
          const result = await rescoreDraft(initial.id, { title: nextTitle, body: nextBody });
          if (result.ok && result.data) setReport(result.data);
        });
      }, 450);
    },
    [initial.id],
  );

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const save = () =>
    startTransition(async () => {
      const result = await saveDraftEdit(initial.id, {
        title,
        body,
        firstComment,
        flair,
        primarySubreddit: subreddit,
      });
      setMessage(result.ok ? 'Saved.' : (result.error ?? 'Could not save.'));
      if (result.ok) router.refresh();
    });

  const approve = (publishNow: boolean) =>
    startTransition(async () => {
      await saveDraftEdit(initial.id, {
        title,
        body,
        firstComment,
        flair,
        primarySubreddit: subreddit,
      });
      const result = await approveDraft(initial.id, { subreddit, publishNow });
      if (result.ok) {
        setMessage(publishNow ? 'Ready to post.' : `Scheduled for ${result.data?.scheduledFor ?? 'the next slot'}.`);
        router.refresh();
      } else {
        setMessage(result.error ?? 'Blocked by your guardrails.');
      }
    });

  const reject = () =>
    startTransition(async () => {
      await rejectDraft(initial.id);
      router.push('/dashboard');
      router.refresh();
    });

  const score = report?.score ?? initial.authenticityScore;
  const breakdown = report?.breakdown ?? initial.authenticityBreakdown;
  const directives = report?.directives ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="title">
            Title
          </label>
          <Input
            id="title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              scheduleRescore(e.target.value, body);
            }}
            className="text-base"
          />
          {initial.titleVariants.length > 1 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {initial.titleVariants.map((variant, i) => (
                <button
                  key={variant}
                  type="button"
                  onClick={() => {
                    setTitle(variant);
                    scheduleRescore(variant, body);
                  }}
                  className={
                    variant === title
                      ? 'rounded-full border bg-accent px-2.5 py-1 text-xs'
                      : 'rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent/50'
                  }
                >
                  A/B {i + 1}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="body">
              Body
            </label>
            <span className="text-xs text-muted-foreground">{body.length} characters</span>
          </div>
          <Textarea
            id="body"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              scheduleRescore(title, e.target.value);
            }}
            className="min-h-[320px] font-mono text-[13px] leading-relaxed"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="comment">
            First comment
          </label>
          <Textarea
            id="comment"
            value={firstComment}
            onChange={(e) => setFirstComment(e.target.value)}
            className="min-h-[90px]"
          />
          <p className="text-xs text-muted-foreground">
            The OP follow-up that adds value and seeds the thread. You paste this yourself - Upvote never
            posts it without you.
          </p>
        </div>
      </div>

      <aside className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Voice match</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <VoiceScore score={score} breakdown={breakdown} threshold={threshold} />
            {pending && <p className="text-xs text-muted-foreground">Scoring...</p>}
            {directives.length > 0 && (
              <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
                {directives.slice(0, 5).map((directive) => (
                  <li key={directive}>→ {directive}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Where to post</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={subreddit}
              placeholder="subreddit"
              onChange={(e) => setSubreddit(e.target.value.replace(/^\/?r\//, ''))}
            />
            <Input value={flair} placeholder="flair (optional)" onChange={(e) => setFlair(e.target.value)} />
            <ul className="space-y-1 text-xs">
              {suggestions.map((s) => (
                <li key={s.subreddit} className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setSubreddit(s.subreddit)}
                    className="truncate text-left hover:underline"
                  >
                    r/{s.subreddit}
                  </button>
                  <span className="font-mono tabular-nums text-muted-foreground">{s.fit.toFixed(0)}</span>
                </li>
              ))}
            </ul>
            {suggestions.length === 0 && (
              <p className="text-xs text-muted-foreground">No compliant subreddit matched. Check the rules.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button className="w-full" onClick={() => approve(false)} disabled={pending}>
              Approve &amp; schedule
            </Button>
            <Button className="w-full" variant="outline" onClick={() => approve(true)} disabled={pending}>
              Approve for immediate post
            </Button>
            <Button className="w-full" variant="ghost" onClick={save} disabled={pending}>
              Save edits
            </Button>
            <Button className="w-full" variant="ghost" onClick={reject} disabled={pending}>
              Not a fit - discard
            </Button>
            {initial.permalink && (
              <a
                href={initial.permalink}
                className="block pt-1 text-center text-xs underline"
                target="_blank"
                rel="noreferrer"
              >
                View the published post
              </a>
            )}
            {initial.scheduledFor && (
              <p className="pt-1 text-center text-xs text-muted-foreground">
                Scheduled: {new Date(initial.scheduledFor).toUTCString()}
              </p>
            )}
            {message && (
              <p className="pt-1 text-center text-xs text-muted-foreground">
                <Badge variant="outline">{message}</Badge>
              </p>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}