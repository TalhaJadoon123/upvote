'use client';

import { cn } from '@/lib/utils';

/**
 * The voice-match score.
 *
 * The 85 line is a product decision, not a preference: drafts below it never
 * reach the queue. Showing the threshold on the meter teaches founders why a
 * draft was rejected instead of leaving them to guess.
 */
export function VoiceScore({
  score,
  breakdown,
  threshold = 85,
  className,
  showBar = true,
}: {
  score: number;
  breakdown?: Record<string, number>;
  threshold?: number;
  className?: string;
  showBar?: boolean;
}) {
  const passing = score >= threshold;
  const tone = score >= 92 ? 'text-emerald-600' : score >= threshold ? 'text-cyan-600' : score >= 75 ? 'text-amber-600' : 'text-red-600';

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline gap-2">
        <span className={cn('font-mono text-2xl font-semibold tabular-nums', tone)}>{score.toFixed(0)}</span>
        <span className="text-xs text-muted-foreground">/ 100 voice match</span>
        <span
          className={cn(
            'ml-auto rounded-full px-2 py-0.5 text-xs font-medium',
            passing ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800',
          )}
        >
          {passing ? 'passes the gate' : `needs ${(threshold - score).toFixed(0)} more`}
        </span>
      </div>

      {showBar && (
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
          <div
            className={cn('h-full rounded-full transition-all duration-300', passing ? 'bg-emerald-500' : 'bg-amber-500')}
            style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
          />
          {/* The gate itself, drawn on the track. */}
          <span
            className="absolute inset-y-0 w-px bg-foreground/50"
            style={{ left: `${threshold}%` }}
            title={`Authenticity threshold: ${threshold}`}
          />
        </div>
      )}

      {breakdown && Object.keys(breakdown).length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-xs sm:grid-cols-3">
          {Object.entries(breakdown).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <dt className="truncate text-muted-foreground">{humanizeKey(key)}</dt>
              <dd
                className={cn(
                  'font-mono tabular-nums',
                  value >= 90 ? 'text-emerald-600' : value >= 70 ? 'text-amber-600' : 'text-red-600',
                )}
              >
                {value.toFixed(0)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .toLowerCase()
    .replace(/rate$/, '');
}