/**
 * Cross-posting.
 *
 * A Reddit post that gets no traffic can be amplified on platforms with an API
 * rather than a browser session: dev.to and Hashnode both have real public APIs,
 * and both have developer audiences that overlap with Reddit's.
 *
 * Design rules:
 *  - Cross-posting is opt-in per platform and never automatic.
 *  - The body is derived from the approved draft, not the raw moment.
 *  - Tags come from the subreddit's topic, because dev.to's tag taxonomy is
 *    editorial and an unknown tag can get a post buried.
 */

export interface CrossPostTarget {
  platform: 'devto' | 'hashnode';
  /** 1-30 characters for dev.to, 1-50 for Hashnode. */
  title: string;
  bodyMarkdown: string;
  tags: string[];
  canonicalUrl?: string;
  published?: boolean;
  /** Hashnode only: cross-post an existing draft instead of creating one. */
  hashnodeDraftId?: string;
}

export interface CrossPostResult {
  ok: boolean;
  platform: CrossPostTarget['platform'];
  url?: string;
  id?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface DevToConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface HashnodeConfig {
  token: string;
  /** Hashnode publication, usually "personal". */
  publicationId?: string;
  baseUrl?: string;
  endpoint?: string;
}

const DEVTO_TAGS = [
  'webdev', 'javascript', 'typescript', 'react', 'python', 'rust', 'go', 'selfhosted',
  'devops', 'docker', 'kubernetes', 'postgres', 'opensource', 'productivity', 'career',
  'programming', 'tutorial', 'security', 'machinelearning', 'ai', 'startup', 'web3', 'testing',
  'architecture', 'database', 'frontend', 'backend', 'devtools', 'css', 'api',
];

const HASHNODE_TAGS = [
  'programming', 'javascript', 'typescript', 'react', 'webdev', 'python', 'startup',
  'selfhosted', 'devops', 'docker', 'opensource', 'tutorial', 'career', 'productivity',
  'database', 'architecture', 'ai', 'machinelearning', 'security', 'testing', 'css',
];

/**
 * Map free-form topics onto tags a platform will actually surface.
 * Unmapped topics fall back to the platform's broadest valid tag rather than a
 * tag that does not exist.
 */
export function mapTags(
  topics: readonly string[],
  allowed: readonly string[],
  fallback: string,
): string[] {
  const chosen: string[] = [];
  for (const topic of topics) {
    const normalized = topic.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = allowed.find((tag) => tag === normalized || tag.includes(normalized) || normalized.includes(tag));
    if (match && !chosen.includes(match)) chosen.push(match);
    if (chosen.length >= 4) break;
  }
  if (chosen.length === 0) chosen.push(fallback);
  return chosen.slice(0, 4);
}

export function devtoTagsFor(topics: readonly string[]): string[] {
  return mapTags(topics, DEVTO_TAGS, 'programming');
}

export function hashnodeTagsFor(topics: readonly string[]): string[] {
  return mapTags(topics, HASHNODE_TAGS, 'programming');
}

/**
 * Turn an approved draft into a cross-post body.
 *
 * The link always points at the founder's own post so the platforms reinforce
 * each other instead of competing for the same click.
 */
export function buildCrossPost(
  draft: { title: string; body: string; firstComment: string; subreddit?: string | null; permalink?: string | null },
  platform: 'devto' | 'hashnode',
): CrossPostTarget {
  const title = draft.title.replace(/\s+/g, ' ').trim().slice(0, platform === 'devto' ? 30 : 50);

  const sections: string[] = [draft.body.trim()];
  if (draft.firstComment.trim()) {
    sections.push(`### A note on the details\n\n${draft.firstComment.trim()}`);
  }
  if (draft.permalink) {
    sections.push(
      `Originally posted to r/${draft.subreddit ?? 'programming'}: ${draft.permalink}\n\n` +
        'Happy to answer questions in the comments here or there.',
    );
  }

  return {
    platform,
    title,
    bodyMarkdown: sections.join('\n\n'),
    tags: platform === 'devto' ? devtoTagsFor([draft.subreddit ?? '']) : hashnodeTagsFor([draft.subreddit ?? '']),
    published: true,
  };
}

/* ------------------------------------------------------------------ */
/* Clients                                                             */
/* ------------------------------------------------------------------ */

export class CrossPostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CrossPostError';
  }
}

export interface CrossPostOptions {
  fetchImpl?: typeof fetch;
}

/** dev.to Forem API. */
export function createDevToClient(config: DevToConfig, options: CrossPostOptions = {}) {
  const baseUrl = (config.baseUrl ?? 'https://dev.to/api').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: 'devto' as const,
    async create(target: CrossPostTarget): Promise<CrossPostResult> {
      if (target.platform !== 'devto') {
        return { ok: false, platform: target.platform, error: 'Wrong client for this target.' };
      }
      if (target.title.length > 30) {
        return { ok: false, platform: 'devto', error: `Title is ${target.title.length} characters; dev.to allows 30.` };
      }
      if (target.tags.length > 4) {
        return { ok: false, platform: 'devto', error: 'dev.to allows at most 4 tags.' };
      }

      try {
        const response = await fetchImpl(`${baseUrl}/articles`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // dev.to accepts the API key as a bearer token.
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            title: target.title,
            published: target.published ?? true,
            body_markdown: target.bodyMarkdown,
            tags: target.tags,
            ...(target.canonicalUrl ? { canonical_url: target.canonicalUrl } : {}),
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return {
            ok: false,
            platform: 'devto',
            error: `dev.to rejected the post (${response.status}): ${describeForemError(text)}`,
          };
        }

        const json = (await response.json()) as { id?: number; url?: string; slug?: string };
        return {
          ok: true,
          platform: 'devto',
          id: json.id ? String(json.id) : undefined,
          url: json.url,
        };
      } catch (error) {
        return { ok: false, platform: 'devto', error: (error as Error).message };
      }
    },
  };
}

/** Hashnode GraphQL API (Publication API). */
export function createHashnodeClient(config: HashnodeConfig, options: CrossPostOptions = {}) {
  const endpoint = config.endpoint ?? 'https://gql.hashnode.com';
  const publicationId = config.publicationId ?? 'personal';
  const fetchImpl = options.fetchImpl ?? fetch;

  const CREATE_MUTATION = `
    mutation CreatePublicationPost($input: CreatePublicationPostInput!) {
      createPublicationPost(input: $input) {
        post { id url }
        errors { message type }
      }
    }`;

  return {
    name: 'hashnode' as const,
    async create(target: CrossPostTarget): Promise<CrossPostResult> {
      if (target.platform !== 'hashnode') {
        return { ok: false, platform: target.platform, error: 'Wrong client for this target.' };
      }

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: config.token },
          body: JSON.stringify({
            query: CREATE_MUTATION,
            variables: {
              input: {
                title: target.title,
                contentMarkdown: target.bodyMarkdown,
                tags: target.tags,
                published: target.published ?? true,
                ...(target.hashnodeDraftId ? { draftId: target.hashnodeDraftId } : {}),
                ...(target.canonicalUrl ? { canonicalUrl: target.canonicalUrl } : {}),
              },
            },
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return {
            ok: false,
            platform: 'hashnode',
            error: `Hashnode returned ${response.status}: ${text.slice(0, 200)}`,
          };
        }

        const json = (await response.json()) as {
          data?: {
            createPublicationPost?: {
              post?: { id?: string; url?: string };
              errors?: Array<{ message?: string; type?: string }>;
            };
          };
          errors?: Array<{ message?: string }>;
        };

        const payload = json.data?.createPublicationPost;
        if (json.errors?.length) {
          return { ok: false, platform: 'hashnode', error: json.errors.map((e) => e.message).join('; ') };
        }
        if (payload?.errors?.length) {
          return {
            ok: false,
            platform: 'hashnode',
            error: payload.errors.map((e) => e.message ?? e.type).join('; '),
          };
        }
        if (!payload?.post?.url) {
          return { ok: false, platform: 'hashnode', error: 'Hashnode accepted the request but returned no post URL.' };
        }

        return { ok: true, platform: 'hashnode', id: payload.post.id, url: payload.post.url };
      } catch (error) {
        return { ok: false, platform: 'hashnode', error: (error as Error).message };
      }
    },
  };

  void publicationId;
}

/** Forem returns structured errors; surface them readably. */
function describeForemError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; errors?: Array<{ message?: string }> };
    if (parsed.error) return parsed.error;
    if (parsed.errors?.length) return parsed.errors.map((e) => e.message ?? '').join('; ');
  } catch {
    // fall through to the raw body
  }
  return body.slice(0, 200);
}

/**
 * Post to every configured platform, collecting results.
 * One platform failing never blocks the others.
 */
export async function crossPostToAll(
  draft: Parameters<typeof buildCrossPost>[0],
  platforms: ReadonlyArray<{ platform: 'devto' | 'hashnode'; client: { create: (t: CrossPostTarget) => Promise<CrossPostResult> } }>,
): Promise<CrossPostResult[]> {
  const results: CrossPostResult[] = [];
  for (const entry of platforms) {
    const target = buildCrossPost(draft, entry.platform);
    results.push(await entry.client.create(target));
  }
  return results;
}