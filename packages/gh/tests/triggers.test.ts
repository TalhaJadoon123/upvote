import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER_CONFIG,
  filterCommits,
  firstLessonLine,
  inferTags,
  isShippablePR,
  mapEvent,
  momentFromLocalCommits,
  momentFromWebhook,
  verifyWebhookSignature,
} from '@upvote/gh';
import { createHmac } from 'node:crypto';

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    repository: { full_name: 'acme/ingest', stargazers_count: 128 },
    commits: [
      {
        sha: 'abc123456789',
        message: 'fix: stop the retry loop from caching its own failures\n\nlesson: clever is not the same as correct',
        added: ['src/retry.ts'],
        modified: ['src/ingest.ts'],
        removed: ['src/legacy.ts'],
        added_lines: 40,
        deleted_lines: 22,
        author: { username: 'dev' },
        timestamp: '2026-01-05T10:00:00Z',
        html_url: 'https://github.com/acme/ingest/commit/abc123456789',
      },
    ],
    ...overrides,
  };
}

describe('verifyWebhookSignature', () => {
  const secret = 'shhh';
  const body = JSON.stringify(pushPayload());
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyWebhookSignature(`${body} `, signature, secret)).toBe(false);
  });

  it('rejects a wrong secret and missing headers', () => {
    expect(verifyWebhookSignature(body, 'sha256=deadbeef', secret)).toBe(false);
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, signature, '')).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyWebhookSignature(body, 'sha256=abc', secret)).toBe(false);
  });
});

describe('mapEvent', () => {
  it('maps known headers', () => {
    expect(mapEvent('push')).toBe('push');
    expect(mapEvent('Release')).toBe('release');
    expect(mapEvent('pull_request')).toBe('pull_request');
    expect(mapEvent('issues')).toBe('issues');
  });

  it('falls back to unknown', () => {
    expect(mapEvent('deployment_status')).toBe('unknown');
    expect(mapEvent(null)).toBe('unknown');
  });
});

describe('filterCommits', () => {
  it('keeps a real feature commit', () => {
    const result = filterCommits([
      { message: 'feat: add batch writer', files: ['src/batch.ts'], additions: 120, deletions: 4 },
    ]);
    expect(result.keep).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.detail).toContain('+120');
  });

  it('skips a typo fix', () => {
    const result = filterCommits([
      { message: 'fix typo', files: ['README.md'], additions: 1, deletions: 1 },
    ]);
    expect(result.keep).toBe(false);
  });

  it('skips docs-only changes', () => {
    const result = filterCommits([
      { message: 'docs: rewrite the readme', files: ['README.md', 'docs/guide.md'], additions: 90, deletions: 20 },
    ]);
    expect(result.keep).toBe(false);
    expect(result.reason).toBe('docs_only');
  });

  it('skips dependency bumps', () => {
    const result = filterCommits([
      { message: 'chore(deps): bump lodash from 4.17.20 to 4.17.21', files: ['package.json'], additions: 2, deletions: 2 },
    ]);
    expect(result.keep).toBe(false);
    expect(['dependency_bump', 'ignored_path', 'trivial']).toContain(result.reason);
  });

  it('skips lockfile-only pushes', () => {
    const result = filterCommits([
      { message: 'chore: update lockfile', files: ['pnpm-lock.yaml'], additions: 400, deletions: 380 },
    ]);
    expect(result.keep).toBe(false);
    expect(result.reason).toBe('ignored_path');
  });

  it('skips CI-only changes', () => {
    const result = filterCommits([
      { message: 'ci: bump the node action', files: ['.github/workflows/ci.yml'], additions: 3, deletions: 3 },
    ]);
    expect(result.keep).toBe(false);
  });

  it('keeps a large refactor even though the type is boring', () => {
    const result = filterCommits([
      { message: 'refactor: split the ingest pipeline', files: ['a.ts', 'b.ts', 'c.ts'], additions: 300, deletions: 250 },
    ]);
    expect(result.keep).toBe(true);
  });

  it('honours config overrides', () => {
    const result = filterCommits([{ message: 'feat: tiny', files: ['a.md'], additions: 2, deletions: 1 }], {
      skipDocsOnly: false,
      minChangedFiles: 1,
      minChangedLines: 1,
    });
    expect(result.keep).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(filterCommits([]).keep).toBe(false);
  });

  it('does not require a conventional commit prefix', () => {
    const result = filterCommits([
      { message: 'Rewrote the batching layer', files: ['src/batch.ts'], additions: 60, deletions: 10 },
    ]);
    expect(result.keep).toBe(true);
  });
});

describe('isShippablePR', () => {
  it('accepts a merged PR with a shippable label', () => {
    expect(
      isShippablePR({ labels: [{ name: 'shippable' }], merged_at: '2026-01-01T00:00:00Z' }),
    ).toBe(true);
  });

  it('accepts alternative labels case-insensitively', () => {
    expect(
      isShippablePR({ labels: [{ name: 'Release' }], merged_at: '2026-01-01T00:00:00Z' }),
    ).toBe(true);
  });

  it('rejects a merged PR without the label', () => {
    expect(isShippablePR({ labels: [{ name: 'bug' }], merged_at: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(isShippablePR({ labels: [], merged_at: '2026-01-01T00:00:00Z' })).toBe(false);
  });

  it('rejects an unmerged PR even with the label', () => {
    expect(isShippablePR({ labels: [{ name: 'shippable' }], merged_at: null })).toBe(false);
  });

  it('accepts a custom label list', () => {
    expect(
      isShippablePR({ labels: [{ name: 'promote' }], merged_at: '2026-01-01T00:00:00Z' }, {
        shippableLabels: ['promote'],
      }),
    ).toBe(true);
  });

  it('ships sane defaults', () => {
    expect(DEFAULT_FILTER_CONFIG.shippableLabels).toContain('shippable');
    expect(DEFAULT_FILTER_CONFIG.skipDocsOnly).toBe(true);
  });
});

describe('momentFromWebhook: push', () => {
  it('builds a moment with tags, lesson and source metadata', () => {
    const { moment } = momentFromWebhook('push', pushPayload());
    expect(moment?.kind).toBe('commit');
    expect(moment?.title).toContain('retry loop');
    expect(moment?.lesson).toBe('clever is not the same as correct');
    expect(moment?.tags).toContain('typescript');
    expect(moment?.source.repo).toBe('acme/ingest');
    expect(moment?.source.stars).toBe(128);
    expect(moment?.source.commitCount).toBe(1);
    expect(moment?.source.author).toBe('dev');
  });

  it('skips a push of only trivial commits', () => {
    const payload = pushPayload({
      commits: [
        { sha: 'x', message: 'chore: bump dep', files: ['package.json'], added_lines: 2, deleted_lines: 2 },
      ],
    });
    const result = momentFromWebhook('push', payload);
    expect(result.moment).toBeNull();
    expect(result.skipped).toBeTruthy();
  });

  it('handles an empty push', () => {
    const result = momentFromWebhook('push', { repository: { full_name: 'a/b' }, commits: [] });
    expect(result.moment).toBeNull();
    expect(result.detail).toBe('empty push');
  });

  it('handles a malformed commits payload', () => {
    const result = momentFromWebhook('push', { commits: 'nope' });
    expect(result.moment).toBeNull();
  });

  it('summarises a multi-commit push', () => {
    const payload = pushPayload({
      commits: [
        { sha: 'a', message: 'feat: add the batch writer', files: ['a.ts'], added_lines: 100, deleted_lines: 10 },
        { sha: 'b', message: 'fix: handle empty batches', files: ['b.ts'], added_lines: 30, deleted_lines: 5 },
      ],
    });
    const { moment } = momentFromWebhook('push', payload);
    expect(moment?.whatChanged).toContain('2 commits');
    expect(moment?.source.commitCount).toBe(2);
  });
});

describe('momentFromWebhook: release', () => {
  it('creates a moment on publish', () => {
    const { moment } = momentFromWebhook('release', {
      repository: { full_name: 'acme/tool' },
      action: 'published',
      release: {
        tag_name: 'v2.1.0',
        name: 'v2.1.0 - faster batching',
        body: 'Batching is now 3x faster.\n\nLesson: measure before optimising.',
        html_url: 'https://github.com/acme/tool/releases/tag/v2.1.0',
        published_at: '2026-01-06T09:00:00Z',
      },
    });
    expect(moment?.kind).toBe('release');
    expect(moment?.title).toContain('faster batching');
    expect(moment?.lesson).toBe('measure before optimising.');
  });

  it('ignores drafts, prereleases and deletions', () => {
    const base = { repository: { full_name: 'a/b' }, release: { tag_name: 'v1.0.0' } };
    expect(momentFromWebhook('release', { ...base, action: 'created' }).moment).toBeNull();
    expect(momentFromWebhook('release', { ...base, action: 'deleted' }).moment).toBeNull();
  });
});

describe('momentFromWebhook: pull_request', () => {
  it('creates a moment when a shippable PR merges', () => {
    const { moment } = momentFromWebhook('pull_request', {
      repository: { full_name: 'acme/tool' },
      action: 'closed',
      pull_request: {
        number: 42,
        title: 'Add the batch writer',
        body: 'Rewrites the write path.\n\nLearned: the old path allocated per row.',
        labels: [{ name: 'shippable' }],
        merged_at: '2026-01-07T10:00:00Z',
        changed_files: 6,
        user: { login: 'dev' },
        html_url: 'https://github.com/acme/tool/pull/42',
      },
    });
    expect(moment?.kind).toBe('pr_merged');
    expect(moment?.id).toContain('42');
    expect(moment?.lesson).toContain('allocated per row');
  });

  it('skips a merged PR without the label', () => {
    const result = momentFromWebhook('pull_request', {
      repository: { full_name: 'a/b' },
      action: 'closed',
      pull_request: { number: 1, title: 'typo', labels: [{ name: 'chore' }], merged_at: '2026-01-01T00:00:00Z' },
    });
    expect(result.moment).toBeNull();
    expect(result.skipped).toBe('not_shippable');
  });

  it('skips PR open events', () => {
    expect(
      momentFromWebhook('pull_request', {
        repository: { full_name: 'a/b' },
        action: 'opened',
        pull_request: { number: 1, title: 'x', labels: [{ name: 'shippable' }] },
      }).moment,
    ).toBeNull();
  });
});

describe('momentFromWebhook: issues', () => {
  it('treats a closed bug as a learning moment', () => {
    const { moment } = momentFromWebhook('issues', {
      repository: { full_name: 'a/b' },
      action: 'closed',
      issue: {
        number: 7,
        title: 'Crash on empty payload',
        body: 'Root cause: an unchecked array access.\nLesson: validate at the boundary.',
        labels: [{ name: 'bug' }],
        closed_at: '2026-01-08T00:00:00Z',
      },
    });
    expect(moment?.kind).toBe('issue_closed');
    expect(moment?.whatChanged).toContain('fixed');
    expect(moment?.lesson).toContain('validate at the boundary');
  });

  it('ignores non-close actions', () => {
    expect(
      momentFromWebhook('issues', { action: 'opened', issue: { number: 1, title: 'x' } }).moment,
    ).toBeNull();
  });
});

describe('momentFromWebhook: other events', () => {
  it('never triggers on CI noise', () => {
    const result = momentFromWebhook('check_run', {});
    expect(result.moment).toBeNull();
    expect(result.detail).toMatch(/CI noise/);
  });

  it('returns nothing for unknown events', () => {
    expect(momentFromWebhook('unknown', {}).moment).toBeNull();
  });
});

describe('inferTags', () => {
  it('infers tags from file extensions', () => {
    expect(inferTags('', ['src/main.ts', 'src/util.tsx'])).toEqual(
      expect.arrayContaining(['typescript', 'javascript']),
    );
    expect(inferTags('', ['app/main.py'])).toContain('python');
  });

  it('infers tags from free text', () => {
    expect(inferTags('added the stripe billing webhook')).toContain('billing');
    expect(inferTags('swapped the k8s deployment to helm')).toContain('kubernetes');
  });

  it('returns an empty list when there is nothing to go on', () => {
    expect(inferTags('', [])).toEqual([]);
  });
});

describe('firstLessonLine', () => {
  it('finds an explicit marker', () => {
    expect(firstLessonLine('some notes\nLesson: keep it boring')).toBe('keep it boring');
    expect(firstLessonLine('Turns out: caching was the problem')).toBe('caching was the problem');
  });

  it('falls back to the first substantial line', () => {
    expect(firstLessonLine('short\n\nThis is a long enough line to be worth quoting from here.')).toMatch(/long enough/);
  });

  it('returns nothing for empty input', () => {
    expect(firstLessonLine('')).toBe('');
  });
});

describe('momentFromLocalCommits', () => {
  it('works from local git log output', () => {
    const moment = momentFromLocalCommits('acme/tool', [
      { sha: 'deadbeef', message: 'feat: add the CLI flag', additions: 50, deletions: 2, files: ['src/cli.ts'] },
    ]);
    expect(moment?.title).toContain('CLI flag');
    expect(moment?.source.repo).toBe('acme/tool');
  });

  it('returns null when nothing is worth posting', () => {
    expect(momentFromLocalCommits('acme/tool', [{ sha: 'a', message: 'chore: bump', additions: 1, deletions: 1 }])).toBeNull();
  });
});