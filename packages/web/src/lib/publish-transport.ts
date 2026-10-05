/**
 * The transport that actually talks to Reddit.
 *
 * Kept out of the route module because Next.js only permits handlers and route
 * config as exports from a `route.ts`, and because the dashboard deliberately
 * holds no Reddit token: publishing runs in a worker that owns the founder's
 * credentials.
 */

export interface PublishResult {
  ok: boolean;
  redditId?: string;
  permalink?: string;
  trackedUrl?: string | null;
  error?: string;
}

export type PublishTransport = (input: {
  draftId: string;
  subreddit: string;
  title: string;
  body: string;
  flair: string;
}) => Promise<PublishResult>;

let transport: PublishTransport | null = null;

/** Register the publishing function directly (self-hosted deployments). */
export function registerTransport(fn: PublishTransport): void {
  transport = fn;
}

/**
 * Resolve the transport: an in-process one if registered, otherwise an HTTP call
 * to the worker configured via UPVOTE_REDDIT_PUBLISH_URL.
 * Returns null when neither is configured so the caller can report honestly
 * instead of pretending a post went out.
 */
export function getTransport(): PublishTransport | null {
  if (transport) return transport;

  const url = process.env.UPVOTE_REDDIT_PUBLISH_URL;
  const token = process.env.UPVOTE_WORKER_TOKEN;
  if (!url || !token) return null;

  return async (input) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
    if (!response.ok) return { ok: false, error: `Worker returned ${response.status}` };
    return (await response.json()) as PublishResult;
  };
}