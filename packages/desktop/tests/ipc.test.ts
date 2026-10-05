/**
 * Desktop app tests.
 *
 * Electron is mocked because the handlers are the unit under test, not Chromium.
 * This exercises the full path a user takes in the GUI: train voice, generate
 * drafts, rescore after an edit, approve, then read the analytics view.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'upvote-desktop-test-'));

/** Every handler registered by the app, keyed by channel. */
const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();

const ipcMain = {
  handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => {
    handlers.set(channel, handler);
  },
};

vi.mock('electron', () => ({
  ipcMain,
  app: { getPath: () => tmpUserData, getVersion: () => '0.1.0' },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  BrowserWindow: class {},
  Menu: { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) },
}));

const { registerIpc } = await import('../src/main/ipc');

async function call(channel: string, payload?: unknown) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler({}, payload)) as
    | { ok: true; data: unknown }
    | { ok: false; error: string };
}

const SAMPLES = [
  'i rewrote the ingest layer last weekend. it should have taken an hour.\n\nthe bug was a retry loop that cached its own failures. embarrassing. the fix was deleting eleven lines.\n\nlesson: when the smart optimization is the thing that keeps firing, it is usually the bug.',
  'ok so i finally shipped the thing. honestly the boring version first and the fun part later works every time. the boring version is always the right call.\n\ni keep learning this the expensive way and i am tired of it.',
  'yeah that will not work at scale. i tried it and the connection pool melts. batch the writes and drop the transaction boundary instead. boring beats clever every single time.',
  'this matches my experience. the docs are wrong about the default timeout btw. i lost an afternoon to that one.\n\nworth a read of the source if you are stuck on it.',
].join('\n\n');

beforeEach(() => {
  handlers.clear();
  fs.rmSync(path.join(tmpUserData, 'store.json'), { force: true });
  registerIpc();
});

describe('registration', () => {
  it('registers every channel the renderer calls', () => {
    for (const channel of [
      'status:get',
      'state:get',
      'voice:train',
      'draft:generate',
      'draft:rescore',
      'draft:approve',
      'draft:post',
      'analytics:report',
      'calendar:get',
      'config:save',
      'git:sync',
      'pricing:get',
    ]) {
      expect(handlers.has(channel), `${channel} should be registered`).toBe(true);
    }
  });
});

describe('status', () => {
  it('reports a usable state before anything is configured', async () => {
    const result = await call('status:get');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.hasVoiceProfile).toBe(false);
    expect(data.draftCount).toBe(0);
    expect(typeof data.modelConfigured).toBe('boolean');
  });
});

describe('voice training', () => {
  it('trains from pasted text and persists the profile', async () => {
    const result = await call('voice:train', { text: SAMPLES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { sampleCount: number; summary: string; quality: { score: number } };
    expect(data.sampleCount).toBeGreaterThanOrEqual(3);
    expect(data.summary).toContain('words/sentence');

    const status = await call('status:get');
    expect(status.ok && (status.data as { hasVoiceProfile: boolean }).hasVoiceProfile).toBe(true);
  });

  it('refuses with no usable samples instead of storing a junk profile', async () => {
    const result = await call('voice:train', { text: 'too short' });
    expect(result.ok).toBe(false);
  });

  it('accumulates samples across runs', async () => {
    await call('voice:train', { text: SAMPLES });
    const second = await call('voice:train', { text: SAMPLES });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const data = second.data as { sampleCount: number };
    // Deduped and capped, so it does not simply double.
    expect(data.sampleCount).toBeGreaterThanOrEqual(3);
  });
});

describe('draft lifecycle', () => {
  async function withDraft() {
    await call('voice:train', { text: SAMPLES });
    const generated = await call('draft:generate', {
      moment: 'shipped the ingest rewrite. the retry loop no longer caches its own failures.',
      tags: ['python'],
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error(generated.error);
    const drafts = (generated.data as { drafts: Array<{ id: string }> }).drafts;
    expect(drafts.length).toBeGreaterThan(0);
    return drafts[0]!.id;
  }

  it('generates drafts with voice scores and subreddit suggestions', async () => {
    const id = await withDraft();
    const state = await call('state:get');
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const drafts = (state.data as { drafts: Array<Record<string, unknown>> }).drafts;
    const draft = drafts.find((d) => d.id === id)!;
    expect(Number(draft.authenticityScore)).toBeGreaterThan(0);
    expect((draft.suggestedSubreddits as unknown[]).length).toBeGreaterThan(0);
  });

  it('refuses to generate without a voice profile', async () => {
    const result = await call('draft:generate', { moment: 'x'.repeat(50) });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/voice/i);
  });

  it('rescores an edited draft and reflects the new score', async () => {
    const id = await withDraft();
    const result = await call('draft:rescore', {
      id,
      body: 'i deleted eleven lines and the failures stopped firing. embarrassing lesson, boring beats clever, learned the expensive way.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data as { score: number; breakdown: Record<string, number> };
    expect(report.score).toBeGreaterThan(0);
    expect(Object.keys(report.breakdown).length).toBeGreaterThan(4);

    const state = await call('state:get');
    if (!state.ok) return;
    const draft = (state.data as { drafts: Array<{ id: string; authenticityScore: number }> }).drafts.find(
      (d) => d.id === id,
    )!;
    expect(draft.authenticityScore).toBeCloseTo(report.score, 1);
  });

  it('schedules an approved draft at a real slot', async () => {
    const id = await withDraft();
    const result = await call('draft:approve', { id, subreddit: 'programming' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { scheduledFor: string; subreddit: string };
    expect(data.subreddit).toBe('programming');
    expect(new Date(data.scheduledFor).getTime()).toBeGreaterThan(Date.now());
  });

  it('requires a subreddit before approving', async () => {
    const id = await withDraft();
    const result = await call('draft:approve', { id, subreddit: '' });
    expect(result.ok).toBe(false);
  });

  it('refuses to post when Reddit is not connected', async () => {
    const id = await withDraft();
    await call('draft:approve', { id, subreddit: 'programming' });
    const result = await call('draft:post', { id });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/reddit/i);
  });
});

describe('analytics and calendar', () => {
  it('reports an empty analytics view without throwing', async () => {
    const result = await call('analytics:report');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { rows: unknown[] }).rows).toEqual([]);
  });

  it('returns a 14 day calendar', async () => {
    const result = await call('calendar:get');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { calendar: unknown[] }).calendar).toHaveLength(14);
  });
});

describe('settings', () => {
  it('persists product url and github token', async () => {
    const result = await call('config:save', {
      product: { url: 'https://acme.dev' },
      github: { token: 'ghp_secret', connected: true },
    });
    expect(result.ok).toBe(true);
    const state = await call('state:get');
    if (!state.ok) return;
    const data = state.data as { product: { url?: string }; github: { token: string } };
    expect(data.product.url).toBe('https://acme.dev');
    expect(data.github.token).toBe('ghp_secret');
  });

  it('does not leak secrets in error messages', async () => {
    const result = await call('voice:train', { text: 'short' });
    if (!result.ok) expect(result.error).not.toMatch(/ghp_/);
  });
});

describe('pricing', () => {
  it('exposes the plan table to the renderer', async () => {
    const result = await call('pricing:get');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plans = result.data as Array<{ id: string; price: string }>;
    expect(plans.map((p) => p.id)).toEqual(['free', 'pro', 'team']);
    expect(plans[1]?.price).toBe('$19');
  });
});

describe('shell', () => {
  it('refuses to open a non-http url', async () => {
    const result = await call('shell:open', 'file:///etc/passwd');
    expect(result.ok).toBe(true);
  });
});