#!/usr/bin/env node
/**
 * Upvote CLI entry point.
 *
 * `upvote <command> [args]`. Argument parsing is intentionally hand-rolled:
 * the surface is small, and a dependency-free binary is one less thing between
 * a founder and their drafts.
 */
import { loadConfig, loadState, saveConfig, saveState, CONFIG_DIR } from './store.js';
import * as commands from './commands.js';
import * as ui from './ui.js';

interface CommandSpec {
  name: string;
  run: (args: string[], ctx: commands.CommandContext) => number | Promise<number>;
  summary: string;
  usage?: string;
}

const COMMANDS: CommandSpec[] = [
  { name: 'onboard', run: commands.cmdOnboard, summary: 'Guided setup that produces 5 drafts in about a minute', usage: 'upvote onboard [--file=notes.md] "<what you shipped>"' },
  { name: 'connect', run: commands.cmdConnect, summary: 'Connect GitHub and Reddit', usage: 'upvote connect [github|reddit|all] [--token=ghp_xxx] [--code=xxx]' },
  { name: 'draft', run: commands.cmdDraft, summary: 'Generate drafts for a shipping moment', usage: 'upvote draft "what you shipped" [--tags=python,postgres] [--limit=3]' },
  { name: 'list', run: commands.cmdList, summary: 'Show the draft queue', usage: 'upvote list [draft|review|approved|scheduled|posted]' },
  { name: 'show', run: (a, c) => Promise.resolve(commands.cmdShow(a, c)), summary: 'Show one draft with its full voice breakdown', usage: 'upvote show <draft-id>' },
  { name: 'approve', run: (a, c) => Promise.resolve(commands.cmdApprove(a, c)), summary: 'Approve a draft and schedule it at the best hour', usage: 'upvote approve <draft-id> [--subreddit=webdev] [--now]' },
  { name: 'post', run: commands.cmdPost, summary: 'Publish a draft to Reddit with your own account', usage: 'upvote post <draft-id>' },
  { name: 'schedule', run: commands.cmdSchedule, summary: 'Manage the queue, or run the publishing tick', usage: 'upvote schedule [--tick]' },
  { name: 'suggest', run: commands.cmdSuggest, summary: 'Draft replies to comments on your published post', usage: 'upvote suggest <post-id>' },
  { name: 'metrics', run: commands.cmdMetrics, summary: 'Refresh upvotes, comments and signups from Reddit', usage: 'upvote metrics' },
  { name: 'analyze', run: (a, c) => Promise.resolve(commands.cmdAnalyze(a, c)), summary: 'Performance report and what to change next week', usage: 'upvote analyze' },
  { name: 'voice', run: (a, c) => Promise.resolve(voiceDispatch(a, c)), summary: 'Train or inspect the voice profile', usage: 'upvote voice train [--file=notes.md] | upvote voice show' },
  { name: 'sub', run: commands.cmdSub, summary: 'Inspect a subreddit or match drafts to one', usage: 'upvote sub [match | <name>]' },
  { name: 'templates', run: (a, c) => Promise.resolve(commands.cmdTemplates(a, c)), summary: 'Browse the distribution template library', usage: 'upvote templates [id]' },
  { name: 'git', run: (a, c) => Promise.resolve(commands.cmdGitHub(a, c)), summary: 'Repository triggers and local git sync', usage: 'upvote git watch | upvote git sync [path]' },
  { name: 'status', run: (a, c) => Promise.resolve(commands.cmdStatus(a, c)), summary: 'One-screen summary of where you stand', usage: 'upvote status [--score]' },
  { name: 'config', run: (a, c) => Promise.resolve(commands.cmdConfig(a, c)), summary: 'Credentials, product, guardrails, watched repos', usage: 'upvote config show | upvote config reddit --client-id=...' },
];

async function voiceDispatch(args: string[], ctx: commands.CommandContext): Promise<number> {
  const action = args[0] ?? 'show';
  if (action === 'train' || action === 'retrain') {
    return commands.cmdVoiceTrain(args.slice(1), ctx);
  }
  return commands.cmdStatus(['--score'], ctx);
}

function printHelp(): void {
  ctx0();
  process.stdout.write(`${ui.bold('upvote')} - Reddit growth engine for developers\n\n`);
  process.stdout.write(`${ui.dim('Ship code. We\'ll write the post.')}\n\n`);
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const command of COMMANDS) {
    process.stdout.write(`  ${ui.cyan(command.name.padEnd(width))}  ${command.summary}\n`);
  }
  process.stdout.write(`\n  ${ui.dim('Get started:')} upvote onboard "shipped the thing"\n`);
  process.stdout.write(`  ${ui.dim('Docs:')}         docs/\n\n`);
}

function ctx0(): void {
  /* keeps the help output on one frame before anything else writes */
}

async function main(argv: string[]): Promise<number> {
  const [commandName, ...args] = argv;

  if (!commandName || commandName === 'help' || commandName === '--help' || commandName === '-h') {
    printHelp();
    return 0;
  }
  if (commandName === '--version' || commandName === '-v' || commandName === 'version') {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    process.stdout.write(`${require('../package.json').version as string}\n`);
    return 0;
  }

  const command = COMMANDS.find((c) => c.name === commandName);
  if (!command) {
    process.stderr.write(ui.fail(`Unknown command: ${commandName}\n`));
    process.stderr.write(ui.dim(`  Run \`upvote help\` to see everything.\n`));
    return 1;
  }

  const config = loadConfig();
  const state = loadState();
  const ctx: commands.CommandContext = {
    config,
    state,
    out: (line = '') => process.stdout.write(`${line}\n`),
  };

  try {
    const code = await command.run(args, ctx);
    // Commands mutate config/state; persist whatever changed.
    saveConfig(config);
    saveState(state);
    if (!config.onboardingComplete && command.name === 'onboard') {
      ctx.config.onboardingComplete = true;
      saveConfig(ctx.config);
    }
    process.stdout.write('\n');
    return code;
  } catch (error) {
    const err = error as Error;
    process.stderr.write(`\n${ui.fail(err.message)}\n`);
    if (process.env.UPVOTE_DEBUG) process.stderr.write(`${ui.dim(err.stack ?? '')}\n`);
    else process.stderr.write(ui.dim(`  Set UPVOTE_DEBUG=1 for a stack trace. State lives in ${CONFIG_DIR}\n`));
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});