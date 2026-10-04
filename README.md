<div align="center">

# Upvote

**Ship code. We'll write the post.**

Reddit is the #1 confirmed growth channel for micro-SaaS. Upvote watches your GitHub,
learns how you write, and drafts the post in your voice — then publishes it at the hour
that subreddit actually responds.

[![CI](https://github.com/your-org/upvote/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/upvote/actions)
[![Node](https://img.shields.io/badge/node-22-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## The problem

One founder, describing Reddit's effect on his business:

> Reddit drove more growth than SEO, ads and social combined. I closed a sale in four days with four or five offers on the table.

Then, from another thread, the actual blocker:

> I'm not a content creator and this is kicking my ass.

Both are true. Distribution isn't the problem. **Writing is** — and writing like a human,
for a platform whose readers can smell marketing copy in a second sentence.

## What Upvote does

1. **Watches your repos.** Releases, merged `shippable` PRs and closed bugs become shipping
   moments. Docs-only changes, dependency bumps, lockfile edits and typo fixes are dropped
   before a single word gets written.
2. **Learns your voice.** Past posts, comments, tweets, READMEs and commit messages become a
   29-dimension style profile, weighted by how well each sample performed.
3. **Drafts five options.** Show-and-tell, story, question, data and comment reply — each with
   a subreddit, an hour, a flair, three title variants and a first comment.
4. **Scores every draft 0–100 against your voice.** Under 85 it regenerates rather than
   reaching your queue. Generic copy gets downvoted; matched copy gets upvoted.
5. **Checks the rules.** Sidebars are parsed into machine-checkable constraints — no
   self-promo, links in comments only, flair required, weekly post limits — and
   non-compliant drafts are blocked before you see them.
6. **Posts from your own Reddit account.** Your OAuth token, your karma, your reputation.
   Upvote never posts from a shared account, because that would shadowban every user.
7. **Tracks what it produced.** Upvotes, clicks, signups and revenue per post, and feeds the
   winners back into the next batch of drafts.

## Quick start

```bash
git clone https://github.com/your-org/upvote
cd upvote
pnpm install

# No API keys, no database, no daemon:
pnpm upvote onboard "shipped the rewrite of my ingest layer"
```

That's the whole setup. The CLI writes JSON to `~/.upvote/` and runs the generation engine
locally. It works fully offline.

### From the terminal

```bash
pnpm upvote voice train --file=my-writing.md   # learn your voice
pnpm upvote draft "fixed the retry cache"      # five drafts, scored
pnpm upvote list                                # the queue
pnpm upvote show d1_a2b3                        # full voice breakdown
pnpm upvote approve d1_a2b3                     # schedule at the peak hour
pnpm upvote post d1_a2b3                        # publish, with your account
pnpm upvote analyze                             # what worked, what to change
```

Full reference: [`packages/docs/content/docs/cli.mdx`](packages/docs/content/docs/cli.mdx).

### The dashboard

```bash
cp .env.example .env      # fill in DATABASE_URL, Clerk keys, TOKEN_ENCRYPTION_KEY
docker compose up -d postgres
pnpm --filter @upvote/web db:push
pnpm --filter @upvote/web dev   # http://localhost:3000
```

## Architecture

```
packages/
  core        voice engine · authenticity scorer · subreddit matcher · generator
  voice       profile trainer · platform source adapters · quality scoring
  gh          GitHub client · webhook verification · smart trigger filtering
  reddit      OAuth · posting · metrics · comments · flair
  scheduler   slot selection · queue · retry backoff · cooldowns · BullMQ (optional)
  analytics   performance · attribution · learning loop · weekly report
  cli         17 commands over a zero-setup local store
  web         Next.js 15 dashboard (Tailwind, shadcn/ui, Drizzle, Clerk, Stripe)
  docs        Fumadocs site
```

`core` is pure: no I/O, no clock of its own, no network. Every function takes its inputs
and returns a result, which is why the whole pipeline is unit-testable and why the CLI
needs no services.

### The scoring model

| signal | weight | what it catches |
| --- | --- | --- |
| style match | 24% | register, sentence length, paragraph rhythm |
| vocabulary | 18% | whether your characteristic words appear |
| rhythm | 16% | wall-of-text paragraphs, run-on sentences |
| n-gram similarity | 16% | distance from your real corpus |
| punctuation | 12% | habits you do not have |
| platform-native | 14% | short paragraphs, no link in the first paragraph |
| penalties | − | AI-tell phrases, banned words, emoji bursts |

A critical-dimension multiplier (`formality`, `avgSentenceWords`, `paragraphWords`) sinks a
draft that is technically close but wrong where it matters. With a small training corpus
the tolerances widen rather than pretending to know more than the data supports.

### Guardrails

Enforced before every post, even with auto-posting enabled:

- max 3 posts per day, max 1 per subreddit per week
- subreddit blocklist
- 72-hour cooldown after a removal
- minimum 85 voice score
- manual approval by default
- optionally: never post where you have never commented

## Development

```bash
pnpm install
pnpm typecheck     # tsc across every library package + the apps
pnpm test          # 298 unit tests
pnpm lint
pnpm build         # turbo build
docker compose up -d postgres redis
```

## Configuration

Everything is optional except what the dashboard needs. See
[`.env.example`](.env.example).

| variable | purpose |
| --- | --- |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_MODEL` | higher-quality drafts; omit to use the offline composer |
| `GITHUB_TOKEN` | read releases, commits, PRs |
| `GITHUB_WEBHOOK_SECRET` | verify webhook signatures |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | post as the founder |
| `DATABASE_URL` | dashboard only |
| `CLERK_SECRET_KEY` | dashboard auth |
| `TOKEN_ENCRYPTION_KEY` | encrypts stored OAuth tokens (32 bytes) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | billing |
| `CRON_SECRET` | protects `/api/cron/*` |

## License

MIT. The code is yours; your Reddit account stays yours.