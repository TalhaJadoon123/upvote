'use client';

import { useEffect, useState } from 'react';
import { VoiceScore } from '@/components/voice-score';

/**
 * The onboarding wow moment, rendered statically on the landing page.
 *
 * It shows the queue a founder actually sees, with a live voice-score tick, so
 * the demo is honest about what the tool does rather than a screenshot of a
 * different product.
 */
const DEMO = {
  moment: 'v2.4.0 - the ingest rewrite',
  what: 'the retry loop no longer caches its own failures',
  drafts: [
    {
      style: 'Story',
      title: 'the cache was the bug the whole time',
      score: 93,
      subreddit: 'programming',
      time: 'Tue 8pm local',
      body: `i rewrote the ingest layer last weekend. it should have taken an hour.

the bug was a retry loop that cached its own failures. embarrassing. the fix was deleting eleven lines.

lesson: when the smart optimization is the thing that keeps firing, it's usually the bug.`,
      breakdown: { styleMatch: 96, vocabulary: 91, rhythm: 100, punctuation: 97, ngramSimilarity: 92, platformNative: 100, penalty: 0 },
      status: 'Ready to schedule',
    },
    {
      style: 'Question',
      title: 'how are you handling a retry loop that poisons itself?',
      score: 88,
      subreddit: 'ExperiencedDevs',
      time: 'Wed 12pm local',
      body: `our ingest layer caches its own retry failures and i only found out because a dashboard went quiet.

i have tried a short TTL and a separate failure store. both feel like papering over it.

how are you handling this in production?`,
      breakdown: { styleMatch: 89, vocabulary: 84, rhythm: 100, punctuation: 93, ngramSimilarity: 82, platformNative: 100, penalty: 0 },
      status: 'Ready to schedule',
    },
    {
      style: 'Data',
      title: 'analyzed 412 retry loops. one pattern stands out.',
      score: 91,
      subreddit: 'SaaS',
      time: 'Thu 6pm local',
      body: `ran this down across 412 retry loops in our own telemetry and the numbers are not what i expected.

the headline: 63% of them re-enter on the same failure, which means the retry cannot succeed by definition.

caveat: single product, small sample, i did not control for queue depth. still, the pattern is consistent.`,
      breakdown: { styleMatch: 94, vocabulary: 88, rhythm: 100, punctuation: 96, ngramSimilarity: 90, platformNative: 100, penalty: 0 },
      status: 'Ready to schedule',
    },
  ],
};

export function DraftPreview() {
  const [active, setActive] = useState(0);
  const [score, setScore] = useState(0);
  const draft = DEMO.drafts[active]!;

  // Animate the score so the gate reads as a measurement, not a label.
  useEffect(() => {
    setScore(0);
    let frame = 0;
    const target = draft.score;
    const timer = window.setInterval(() => {
      frame += Math.max(1, Math.round((target - frame) / 6));
      setScore(Math.min(target, frame));
      if (frame >= target) window.clearInterval(timer);
    }, 40);
    return () => window.clearInterval(timer);
  }, [active, draft.score]);

  return (
    <section className="rounded-lg border bg-card p-0 shadow-sm">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <span className="ml-2 font-mono">upvote draft &quot;{DEMO.moment}&quot;</span>
      </div>

      <div className="grid gap-0 lg:grid-cols-[260px_1fr]">
        <div className="border-b p-4 lg:border-b-0 lg:border-r">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Draft queue</p>
          <ul className="mt-3 space-y-2">
            {DEMO.drafts.map((item, i) => (
              <li key={item.style}>
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  className={
                    i === active
                      ? 'w-full rounded-md border bg-accent px-3 py-2 text-left text-sm'
                      : 'w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent/60'
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{item.style}</span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">{item.score}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">r/{item.subreddit}</div>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            5 drafts generated · 1 skipped (no thread context) · 0 below the voice gate
          </p>
        </div>

        <div className="p-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border px-2 py-0.5">{draft.style}</span>
            <span className="rounded-full border px-2 py-0.5">r/{draft.subreddit}</span>
            <span className="rounded-full border px-2 py-0.5">best time: {draft.time}</span>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">{draft.status}</span>
          </div>

          <h3 className="mt-4 text-xl font-semibold leading-snug">{draft.title}</h3>
          <div className="mt-2 text-xs text-muted-foreground">What changed: {DEMO.what}</div>

          <div className="post-body mt-4">{draft.body}</div>

          <div className="mt-6 border-t pt-4">
            <VoiceScore score={score} breakdown={draft.breakdown} />
          </div>
        </div>
      </div>
    </section>
  );
}