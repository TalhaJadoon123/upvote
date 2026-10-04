import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandContext } from '@upvote/cli';

/** Point the CLI's state at a throwaway directory before anything imports it. */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'upvote-cli-test-'));
process.env.UPVOTE_HOME = tmpHome;
// Tests must never reach a model provider, even when a key exists in the
// environment: that turns a unit test into a billed network call.
process.env.UPVOTE_OFFLINE = '1';

const cli = await import('@upvote/cli');
const {
  cmdDraft,
  cmdList,
  cmdShow,
  cmdApprove,
  cmdConfig,
  cmdStatus,
  cmdVoiceTrain,
  cmdTemplates,
  cmdGitHub,
  cmdAnalyze,
  cmdSub,
  loadConfig,
  loadState,
  saveConfig,
  saveState,
  defaultConfig,
  defaultState,
  maskSecret,
} = cli;

const SAMPLES = `i rewrote the ingest layer last weekend. it should have taken an hour.

the bug was a retry loop that cached its own failures. embarrassing. the fix was deleting eleven lines.

lesson: when the smart optimization is the thing that keeps firing, it is usually the bug.

ok so i finally shipped the thing. honestly the boring version first and the fun part later works every time. the boring version is always the right call.

yeah that won't work at scale. i tried it, the connection pool melts. what i did instead was batch the writes and drop the transaction boundary. boring beats clever every time.

this matches my experience. the docs are wrong about the default timeout btw.

i keep learning this the expensive way. the boring version first, always. embarrassing but it works.`;

type TestCtx = CommandContext & { lines: string[] };

function ctx(overrides: Partial<CommandContext> = {}): TestCtx {
  const lines: string[] = [];
  return {
    config: loadConfig(),
    state: loadState(),
    out: (line = '') => lines.push(line),
    lines,
    ...overrides,
  };
}

const output = (c: TestCtx) => c.lines.join('\n');

function writeSamples(): string {
  const file = path.join(tmpHome, 'samples.md');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(file, SAMPLES, 'utf8');
  return file;
}

/** A context with a trained voice profile. */
async function trained(): Promise<TestCtx> {
  const c = ctx();
  await cmdVoiceTrain([`--file=${writeSamples()}`], c);
  c.lines.length = 0;
  return c;
}

/** A context with a trained voice profile and one generated draft. */
async function withDraft(): Promise<TestCtx> {
  const c = await trained();
  await cmdDraft(['fixed the retry cache in my ingest layer'], c);
  // prior-engagement guardrail: pretend we have commented in these subs.
  c.state.engagedSubreddits = [
    'programming', 'webdev', 'selfhosted', 'SaaS', 'SideProject', 'ExperiencedDevs',
    'indiehackers', 'devops', 'LocalLLaMA', 'datascience', 'netsec', 'IBuiltThis', 'smallbusiness',
  ];
  c.lines.length = 0;
  return c;
}

beforeEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(tmpHome, { recursive: true });
});

describe('store', () => {
  it('returns defaults when nothing is stored', () => {
    const config = loadConfig();
    expect(config.plan).toBe('pro');
    expect(config.guardrails.minAuthenticityScore).toBe(85);
    expect(config.guardrails.maxPostsPerDay).toBe(3);
    expect(loadState().drafts).toEqual([]);
  });

  it('round-trips config and state', () => {
    const config = defaultConfig();
    config.product.name = 'Acme';
    saveConfig(config);
    expect(loadConfig().product.name).toBe('Acme');

    const state = defaultState();
    state.engagedSubreddits = ['webdev'];
    saveState(state);
    expect(loadState().engagedSubreddits).toEqual(['webdev']);
  });

  it('writes atomically and leaves no temp file', () => {
    saveConfig(defaultConfig());
    const files = fs.readdirSync(tmpHome);
    expect(files).toContain('config.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('falls back to defaults on corrupt JSON', () => {
    fs.writeFileSync(path.join(tmpHome, 'config.json'), '{not json', 'utf8');
    expect(loadConfig().plan).toBe('pro');
  });

  it('masks secrets', () => {
    expect(maskSecret(undefined)).toBe('(not set)');
    expect(maskSecret('short')).toBe('*****');
    expect(maskSecret('ghp_abcdefghijklmnop')).toBe('ghp_...mnop');
  });
});

describe('config command', () => {
  it('shows the current config without leaking secrets', async () => {
    const c = ctx();
    await cmdConfig(['show'], c);
    expect(output(c)).toContain('github token');
    expect(output(c)).not.toMatch(/ghp_[a-z0-9]{8,}/);
  });

  it('sets reddit credentials', async () => {
    const c = ctx();
    await cmdConfig(['reddit', '--client-id=abc', '--client-secret=def'], c);
    expect(loadConfig().reddit.clientId).toBe('abc');
    expect(c.config.reddit.clientSecret).toBe('def');
  });

  it('sets product info used for attribution links', async () => {
    const c = ctx();
    await cmdConfig(['product', '--name=Acme', '--url=https://acme.dev'], c);
    expect(c.config.product.url).toBe('https://acme.dev');
  });

  it('adjusts guardrails', async () => {
    const c = ctx();
    await cmdConfig(['guardrails', '--max-per-day=1', '--min-voice=90', '--auto', '--block=netsec'], c);
    expect(c.config.guardrails.maxPostsPerDay).toBe(1);
    expect(c.config.guardrails.minAuthenticityScore).toBe(90);
    expect(c.config.guardrails.requireManualApproval).toBe(false);
    expect(c.config.guardrails.blocklist).toContain('netsec');
  });

  it('adds watched repositories', async () => {
    const c = ctx();
    await cmdConfig(['watch', '--repo=acme/tool'], c);
    expect(c.config.watch.repos[0]).toMatchObject({ owner: 'acme', repo: 'tool' });
  });
});

describe('voice training', () => {
  it('trains from a file and explains the result', async () => {
    const c = ctx();
    const code = await cmdVoiceTrain([`--file=${writeSamples()}`], c);
    expect(code).toBe(0);
    expect(c.state.voiceProfile).not.toBeNull();
    expect(c.state.voiceProfile!.sampleCount).toBeGreaterThan(3);
    const text = output(c);
    expect(text).toMatch(/Trained on \d+ samples/);
    expect(text).toMatch(/Signature phrasing/);
    expect(text).toMatch(/Quality/);
  });

  it('fails helpfully with nothing to learn from', async () => {
    const c = ctx();
    expect(await cmdVoiceTrain([], c)).toBe(1);
    expect(output(c)).toMatch(/No usable samples/);
  });
});

describe('draft command', () => {
  it('refuses without a voice profile', async () => {
    const c = ctx();
    await expect(cmdDraft(['shipped a thing'], c)).rejects.toThrow(/voice train/);
  });

  it('requires a description', async () => {
    const c = await trained();
    expect(await cmdDraft([], c)).toBe(1);
    expect(output(c)).toMatch(/Describe what you shipped/);
  });

  it('generates drafts and shows them', async () => {
    const c = await trained();
    const code = await cmdDraft(['fixed the retry cache in my ingest layer', '--tags=python,postgres'], c);
    expect(code).toBe(0);
    expect(c.state.drafts.length).toBeGreaterThan(0);
    const text = output(c);
    expect(text).toMatch(/voice\s+\d+/);
    expect(text).toMatch(/best time:/);
    expect(text).toMatch(/first comment:/);
  });

  it('enforces the plan draft limit', async () => {
    const c = await trained();
    c.config.plan = 'free';
    expect(await cmdDraft(['first thing shipped'], c)).toBe(0);
    // Burn through the free allowance for this month.
    c.state.drafts = Array.from({ length: 3 }, (_, i) => ({
      ...c.state.drafts[0]!,
      id: `old_${i}`,
      createdAt: new Date().toISOString(),
    }));
    expect(await cmdDraft(['fourth thing'], c)).toBe(1);
    expect(output(c)).toMatch(/Free plan allows/);
  });
});

describe('list and show', () => {
  it('lists the queue in a table', async () => {
    const c = await withDraft();
    cmdList([], c);
    const text = output(c);
    expect(text).toContain('ID');
    expect(text).toContain('VOICE');
    expect(text).toMatch(/r\/\w+/);
  });

  it('says so when the queue is empty', async () => {
    const c = ctx();
    cmdList([], c);
    expect(output(c)).toMatch(/No drafts yet/);
  });

  it('filters by status', async () => {
    const c = await withDraft();
    cmdList(['posted'], c);
    expect(output(c)).toMatch(/No drafts yet|nothing yet/);
  });

  it('shows the full voice breakdown for one draft', async () => {
    const c = await withDraft();
    const id = c.state.drafts[0]!.id;
    cmdShow([id], c);
    const text = output(c);
    expect(text).toContain('styleMatch');
    expect(text).toContain('Subreddit suggestions');
  });

  it('reports an unknown id', async () => {
    const c = await withDraft();
    cmdShow(['nope'], c);
    expect(output(c)).toMatch(/No draft with id/);
  }, 60_000);
});

describe('approve', () => {
  it('schedules an approved draft', async () => {
    const c = await withDraft();
    const id = c.state.drafts[0]!.id;
    expect(await cmdApprove([id], c)).toBe(0);
    const draft = c.state.drafts.find((d) => d.id === id)!;
    expect(draft.status).toBe('scheduled');
    expect(draft.scheduledFor).toBeTruthy();
    expect(output(c)).toMatch(/Scheduled for r\//);
  });

  it('blocks when the subreddit is on the blocklist', async () => {
    const c = await withDraft();
    const primary = c.state.drafts[0]!.primarySubreddit!;
    c.config.guardrails.blocklist = [primary];
    expect(await cmdApprove([c.state.drafts[0]!.id], c)).toBe(1);
    expect(output(c)).toMatch(/blocklist/);
  });

  it('blocks a second post to the same subreddit within the week', async () => {
    const c = await withDraft();
    const first = c.state.drafts[0]!;
    expect(await cmdApprove([first.id], c)).toBe(0);
    const second = { ...first, id: 'draft_second' };
    c.state.drafts.push(second);
    c.lines.length = 0;
    expect(await cmdApprove(['draft_second'], c)).toBe(1);
    expect(output(c)).toMatch(/Already posted in r\/|legal slot/);
  }, 60_000);

  it('rejects a draft under the authenticity threshold', async () => {
    const c = await withDraft();
    c.config.guardrails.minAuthenticityScore = 99;
    expect(await cmdApprove([c.state.drafts[0]!.id], c)).toBe(1);
    expect(output(c)).toMatch(/below your threshold/);
  });

  it('reports an unknown id', async () => {
    const c = await withDraft();
    expect(await cmdApprove(['nope'], c)).toBe(1);
  });
});

describe('status, analyze, templates, sub, git', () => {
  it('summarizes an empty install', async () => {
    const c = ctx();
    cmdStatus([], c);
    expect(output(c)).toMatch(/not trained yet/);
  });

  it('prints the voice fingerprint with --score', async () => {
    const c = await trained();
    cmdStatus(['--score'], c);
    expect(output(c)).toContain('Voice fingerprint');
    expect(output(c)).toContain('avgSentenceWords');
  });

  it('analyzes with nothing published', async () => {
    const c = ctx();
    cmdAnalyze([], c);
    expect(output(c)).toMatch(/Nothing published yet/);
  });

  it('lists the template library', async () => {
    const c = ctx();
    cmdTemplates([], c);
    const text = output(c);
    expect(text).toContain('built_in_days');
    expect(text).toContain('hit_mrr');
  });

  it('shows one template', async () => {
    const c = ctx();
    cmdTemplates(['mistakes'], c);
    expect(output(c)).toMatch(/specific/);
  });

  it('rejects an unknown template', async () => {
    const c = ctx();
    expect(await cmdTemplates(['nope'], c)).toBe(1);
  });

  it('shows repository triggers', async () => {
    const c = ctx();
    cmdGitHub(['watch'], c);
    const text = output(c);
    expect(text).toMatch(/docs-only/);
    expect(text).toMatch(/dependency bumps/);
  });

  it('inspects a subreddit from the fallback pool', async () => {
    const c = ctx();
    expect(await cmdSub(['programming'], c)).toBe(0);
    expect(output(c)).toMatch(/r\/programming/);
  });

  it('matches drafts to subreddits', async () => {
    const c = await withDraft();
    expect(await cmdSub(['match'], c)).toBe(0);
    expect(output(c)).toMatch(/fit\s+\d+/);
  });
});