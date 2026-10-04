import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getDashboardData } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Voice profile page.
 *
 * The sliders do not retrain anything - they adjust the *targets* the generator
 * aims at, which is how a founder gets a draft to sound more/less like the
 * register they want without waiting for a retrain.
 */
export default async function VoicePage() {
  const { profile } = await getDashboardData();

  if (!profile) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Voice</h1>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No profile yet. Connect Reddit and we will read your past writing — or paste a few of your
            posts and we will train from those.
          </CardContent>
        </Card>
      </div>
    );
  }

  const vector = profile.vector as Record<string, number>;
  const settings = profile.settings as Record<string, unknown>;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Voice</h1>
        <p className="text-sm text-muted-foreground">
          Version {profile.version} · trained on {profile.sampleCount} samples · quality {profile.qualityScore}/100
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What you sound like</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(vector).map(([key, value]) => (
              <div key={key} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 truncate text-muted-foreground">
                  {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-foreground/70"
                    style={{ width: `${Math.min(100, (value / Math.max(key === 'wordsPerPost' ? 400 : 1, 1)) * 100)}%` }}
                  />
                </span>
                <span className="w-10 text-right font-mono text-xs tabular-nums">{value.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Signature phrasing</CardTitle>
        </CardHeader>
        <CardContent>
          {profile.signaturePhrases.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not enough recurring phrasing yet. Add more of your own writing.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {profile.signaturePhrases.map((phrase) => (
                <Badge key={phrase} variant="outline">
                  {phrase}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vocabulary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">You use</h4>
            <div className="mt-2 flex flex-wrap gap-2">
              {profile.favoriteWords.slice(0, 24).map((word) => (
                <Badge key={word} variant="success">
                  {word}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Never use (drafts are penalised)
            </h4>
            <div className="mt-2 flex flex-wrap gap-2">
              {profile.bannedWords.slice(0, 24).map((word) => (
                <Badge key={word} variant="danger">
                  {word}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Targets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {Object.entries(settings).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between border-b pb-2 last:border-0">
              <span className="text-muted-foreground">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
              <span className="font-mono text-xs tabular-nums">{String(value)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}